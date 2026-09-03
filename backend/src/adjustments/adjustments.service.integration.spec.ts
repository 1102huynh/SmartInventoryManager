import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as daysCutoff from '../common/days-cutoff';
import { AdjustmentRequestStatus } from '../common/enums/adjustment-request-status.enum';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { TransactionType } from '../common/enums/transaction-type.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { createTestDataSource } from '../database/test-data-source';
import { InventoryService } from '../inventory/inventory.service';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { User } from '../users/user.entity';
import { AdjustmentRequest } from './adjustment-request.entity';
import { AdjustmentsService } from './adjustments.service';

// INTEGRATION, not unit (see inventory.service.integration.spec.ts for the rationale):
// the whole point of the approval path is that the delta is computed under a real
// pessimistic row lock at approval time, and that the transaction insert plus the
// request flip are one atomic unit — neither of which a mock repository can prove.
//
// Requires the local Postgres from tools/ to be running.
describe('AdjustmentsService (integration)', () => {
  let dataSource: DataSource;
  let inventory: InventoryService;
  let service: AdjustmentsService;
  let productId: number;
  let staff: { id: number; role: UserRole };
  let owner: { id: number; role: UserRole };
  let otherOwner: { id: number; role: UserRole };

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    inventory = new InventoryService(
      dataSource,
      dataSource.getRepository(InventoryTransaction),
    );
    service = new AdjustmentsService(
      dataSource,
      dataSource.getRepository(AdjustmentRequest),
      dataSource.getRepository(Product),
      inventory,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE adjustment_requests, inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const users = dataSource.getRepository(User);
    const s = await users.save({
      name: 'Sam Staff',
      role: UserRole.Staff,
      email: 'sam@example.com',
      passwordHash: 'unused',
    });
    const o = await users.save({
      name: 'Olivia Owner',
      role: UserRole.Owner,
      email: 'olivia@example.com',
      passwordHash: 'unused',
    });
    const o2 = await users.save({
      name: 'Otis Owner',
      role: UserRole.Owner,
      email: 'otis@example.com',
      passwordHash: 'unused',
    });
    staff = { id: s.id, role: UserRole.Staff };
    owner = { id: o.id, role: UserRole.Owner };
    otherOwner = { id: o2.id, role: UserRole.Owner };
    const product = await dataSource.getRepository(Product).save({
      sku: 'AR-1',
      name: 'Adjustable Widget',
      unit: 'unit',
      status: EntityStatus.ACTIVE,
    });
    productId = product.id;
  });

  async function stockIn(qty: number, date = '2026-08-01'): Promise<void> {
    await inventory.recordStockIn(
      productId,
      { quantity: qty, occurredAt: date },
      owner.id,
    );
  }

  async function submitStaff(
    newQuantity: number,
    date = '2026-08-05',
  ): Promise<AdjustmentRequest> {
    const result = await service.submit(
      productId,
      { newQuantity, occurredAt: date, reason: 'Stocktake correction' },
      staff,
    );
    if (result.outcome !== 'requested')
      throw new Error('expected a pending request');
    return result.request;
  }

  // THE headline test (§5): approval computes the delta against stock AS OF APPROVAL,
  // not as of request. Verified the way Phase 11 verified its tie-break — by changing
  // applyApprovedAdjustment to `params.newQuantity - stockAtRequest` and confirming
  // this goes red. A test that passes on both trees proves nothing.
  it('computes the delta against current stock at approval, not the stock the requester saw', async () => {
    await stockIn(35);
    const request = await submitStaff(40); // requester counted 40 against a system showing 35
    expect(request.stockAtRequest).toBe(35);

    // Stock moves after the request is filed but before it is approved.
    await inventory.recordStockOut(
      productId,
      { quantity: 3, occurredAt: '2026-08-06' },
      owner.id,
    );
    expect(await inventory.getCurrentStock(productId)).toBe(32);

    const approved = await service.resolve(
      request.id,
      { status: AdjustmentRequestStatus.APPROVED },
      owner,
    );

    expect(approved.status).toBe(AdjustmentRequestStatus.APPROVED);
    expect(approved.resolvedByUserId).toBe(owner.id);
    expect(approved.resolutionReason).toBeNull(); // optional on approve, none given
    expect(approved.resultingTransactionId).not.toBeNull();
    const tx = await dataSource
      .getRepository(InventoryTransaction)
      .findOneByOrFail({ id: approved.resultingTransactionId! });
    expect(tx.quantityDelta).toBe(8); // 40 - 32, NOT 40 - 35
    expect(tx.recordedByUserId).toBe(staff.id); // BR-088: attributed to the requester
    expect(await inventory.getCurrentStock(productId)).toBe(40);
  });

  // §5 "Atomicity" — the one failure mode that would silently produce the exact thing
  // the phase prevents. Force a failure AFTER the transaction row is inserted and
  // assert the whole unit rolled back.
  it('is atomic: a failure after the transaction insert leaves no transaction and a still-pending request', async () => {
    await stockIn(10);
    const request = await submitStaff(25);

    const real: InventoryService['applyApprovedAdjustment'] =
      inventory.applyApprovedAdjustment.bind(inventory);
    const spy = jest
      .spyOn(inventory, 'applyApprovedAdjustment')
      .mockImplementation(async (manager, params) => {
        await real(manager, params); // the insert really happens...
        throw new Error('boom — simulated failure after the insert'); // ...then the unit fails
      });

    await expect(
      service.resolve(
        request.id,
        { status: AdjustmentRequestStatus.APPROVED },
        owner,
      ),
    ).rejects.toThrow('boom');

    spy.mockRestore();

    // No adjustment row survived the rollback (the stock-in from setup is still there).
    expect(
      await dataSource
        .getRepository(InventoryTransaction)
        .countBy({ type: TransactionType.ADJUSTMENT }),
    ).toBe(0);
    const after = await dataSource
      .getRepository(AdjustmentRequest)
      .findOneByOrFail({ id: request.id });
    expect(after.status).toBe(AdjustmentRequestStatus.PENDING);
    expect(after.resultingTransactionId).toBeNull();
    expect(await inventory.getCurrentStock(productId)).toBe(10);
  });

  // §5 "Zero-delta by drift" → 409, request stays pending.
  it('rejects approval as 409 when drift has made the count a no-op, and leaves the request pending', async () => {
    await stockIn(10);
    const request = await submitStaff(15);
    await stockIn(5, '2026-08-06'); // stock is now 15 — exactly what was counted

    await expect(
      service.resolve(
        request.id,
        { status: AdjustmentRequestStatus.APPROVED },
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const after = await dataSource
      .getRepository(AdjustmentRequest)
      .findOneByOrFail({ id: request.id });
    expect(after.status).toBe(AdjustmentRequestStatus.PENDING);
  });

  // §5: concurrent approval of two requests on one product — in the spirit of the
  // existing concurrent stock-out test. Both approve, neither corrupts stock, and the
  // second one's delta reflects the first one's effect.
  it('serializes concurrent approvals of two requests on one product without corrupting stock', async () => {
    await stockIn(10);
    const reqA = await submitStaff(20);
    const reqB = await submitStaff(5);

    await Promise.all([
      service.resolve(
        reqA.id,
        { status: AdjustmentRequestStatus.APPROVED },
        owner,
      ),
      service.resolve(
        reqB.id,
        { status: AdjustmentRequestStatus.APPROVED },
        otherOwner,
      ),
    ]);

    const rows = await dataSource
      .getRepository(AdjustmentRequest)
      .find({ order: { resultingTransactionId: 'ASC' } });
    expect(
      rows.every((r) => r.status === AdjustmentRequestStatus.APPROVED),
    ).toBe(true);

    // Whichever was applied second set the final stock to its own counted total, and
    // the running SUM(quantity_delta) is internally consistent either way.
    const lastApplied = rows.reduce((a, b) =>
      (b.resultingTransactionId ?? 0) > (a.resultingTransactionId ?? 0) ? b : a,
    );
    const finalStock = await inventory.getCurrentStock(productId);
    expect(finalStock).toBe(lastApplied.newQuantity);
    expect([5, 20]).toContain(finalStock);
  });

  // §5 "a resolved request being resolved again → 409, not a silent second approval".
  it('409s a second resolution of an already-approved request', async () => {
    await stockIn(10);
    const request = await submitStaff(15);
    await service.resolve(
      request.id,
      { status: AdjustmentRequestStatus.APPROVED },
      owner,
    );

    await expect(
      service.resolve(
        request.id,
        { status: AdjustmentRequestStatus.REJECTED, reason: 'too late' },
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('records a rejection with its reason and changes no stock', async () => {
    await stockIn(10);
    const request = await submitStaff(99);
    const rejected = await service.resolve(
      request.id,
      {
        status: AdjustmentRequestStatus.REJECTED,
        reason: 'Recount looks wrong',
      },
      owner,
    );
    expect(rejected.status).toBe(AdjustmentRequestStatus.REJECTED);
    expect(rejected.resolutionReason).toBe('Recount looks wrong');
    expect(rejected.resultingTransactionId).toBeNull();
    expect(await inventory.getCurrentStock(productId)).toBe(10);
  });

  describe('the bounded list read (Phase 11 convention)', () => {
    async function seedRequests(n: number): Promise<void> {
      await stockIn(1000);
      for (let i = 0; i < n; i++) {
        await service.submit(
          productId,
          {
            newQuantity: 100 + i,
            occurredAt: '2026-08-05',
            reason: `count ${i}`,
          },
          staff,
        );
      }
    }

    it('caps at the default of 100, honours an explicit limit, and reports truncation from the limit+1 probe', async () => {
      await seedRequests(150);

      const def = await service.list({});
      expect(def.rows).toHaveLength(100);
      expect(def.truncated).toBe(true);

      const max = await service.list({ limit: 500 });
      expect(max.rows).toHaveLength(150);
      expect(max.truncated).toBe(false);

      const exact = await service.list({ limit: 150 });
      expect(exact.rows).toHaveLength(150);
      expect(exact.truncated).toBe(false);

      const under = await service.list({ limit: 149 });
      expect(under.rows).toHaveLength(149);
      expect(under.truncated).toBe(true);
    });

    it('filters by status and by product', async () => {
      await seedRequests(3);
      const [a] = (await service.list({ limit: 1 })).rows;
      await service.resolve(
        a.id,
        { status: AdjustmentRequestStatus.REJECTED, reason: 'x' },
        owner,
      );

      const pending = await service.list({
        status: AdjustmentRequestStatus.PENDING,
      });
      expect(pending.rows).toHaveLength(2);
      const rejected = await service.list({
        status: AdjustmentRequestStatus.REJECTED,
      });
      expect(rejected.rows).toHaveLength(1);
    });

    // Finding 4 (review): a Staff caller's list is scoped to their own requests; an
    // Owner (and an unscoped call) sees the whole queue.
    it('scopes the list to the caller when the caller is Staff', async () => {
      await seedRequests(3); // three requests by `staff`
      const other = await dataSource.getRepository(User).save({
        name: 'Sid Staff',
        role: UserRole.Staff,
        email: 'sid@example.com',
        passwordHash: 'unused',
      });
      await service.submit(
        productId,
        { newQuantity: 500, occurredAt: '2026-08-05', reason: 'sid' },
        { id: other.id, role: UserRole.Staff },
      );

      const asOwner = await service.list({}, owner);
      expect(asOwner.rows).toHaveLength(4);

      const asStaff = await service.list({}, staff);
      expect(asStaff.rows).toHaveLength(3);
      expect(asStaff.rows.every((r) => r.requestedByUserId === staff.id)).toBe(
        true,
      );

      const asOther = await service.list(
        {},
        { id: other.id, role: UserRole.Staff },
      );
      expect(asOther.rows).toHaveLength(1);
      expect(asOther.rows[0].newQuantity).toBe(500);

      // An unscoped call (the integration-only path) still sees everything.
      expect((await service.list({})).rows).toHaveLength(4);
    });
  });

  describe('the ?days= window', () => {
    // §5: created_at is a real instant, so `?days=` must use daysCutoffForInstantColumn
    // (the /audit-events branch), NOT daysCutoffForDateColumn. The two functions agree
    // on this project's UTC+7 dev / UTC CI, so a data-fixture test cannot go red
    // against the wrong one here (the same limitation inventory.service.integration's
    // hour-independence test documents). This spy test can: it asserts the SELECTION
    // directly and goes red the moment someone swaps the import, on any machine.
    it('selects daysCutoffForInstantColumn and never daysCutoffForDateColumn', async () => {
      const instantSpy = jest.spyOn(daysCutoff, 'daysCutoffForInstantColumn');
      const dateSpy = jest.spyOn(daysCutoff, 'daysCutoffForDateColumn');
      try {
        await service.list({ days: 7 });
        expect(instantSpy).toHaveBeenCalledWith(7);
        expect(dateSpy).not.toHaveBeenCalled();
      } finally {
        instantSpy.mockRestore();
        dateSpy.mockRestore();
      }
    });

    // Pins the calendar-window property end to end against real rows (a row well
    // outside 7 days is excluded; a recent one is included).
    it('excludes a request whose created_at is older than the window', async () => {
      await stockIn(1000);
      await service.submit(
        productId,
        { newQuantity: 1, occurredAt: '2026-08-05', reason: 'recent' },
        staff,
      );
      await service.submit(
        productId,
        { newQuantity: 2, occurredAt: '2026-08-05', reason: 'old' },
        staff,
      );
      await dataSource.query(
        `UPDATE adjustment_requests SET created_at = now() - interval '30 days' WHERE new_quantity = 2`,
      );

      const recent = await service.list({ days: 7 });
      expect(recent.rows).toHaveLength(1);
      expect(recent.rows[0].newQuantity).toBe(1);
    });
  });
});
