import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { createTestDataSource } from '../database/test-data-source';
import { Product } from '../products/product.entity';
import { User } from '../users/user.entity';
import { InventoryService } from './inventory.service';
import { InventoryTransaction } from './inventory-transaction.entity';

// An INTEGRATION test, not a unit test: it runs against a real PostgreSQL database
// (see database/test-data-source.ts) instead of a mocked repository. That's a
// deliberate choice, not an oversight — the whole point of InventoryService's write
// methods is the row-locking behavior described in inventory.service.ts, and a mock
// repository can't tell you whether a real `SELECT ... FOR UPDATE` actually serializes
// two concurrent transactions. Only a real database can prove that.
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('InventoryService (integration)', () => {
  let dataSource: DataSource;
  let service: InventoryService;
  let productId: number;
  let userId: number;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    service = new InventoryService(
      dataSource,
      dataSource.getRepository(InventoryTransaction),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // Truncate + reset identities so every test starts from a clean, predictable state.
    await dataSource.query(
      'TRUNCATE TABLE inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const user = await dataSource.getRepository(User).save({
      name: 'Test User',
      role: UserRole.Staff,
      email: 'test-user@example.com',
      // Not exercised by anything in this file (no login here — see auth.e2e-spec.ts
      // and auth.service.spec.ts for that) — the users.password_hash column is just
      // NOT NULL, so a row needs *something* in it.
      passwordHash: 'unused-in-this-test',
    });
    userId = user.id;
    const product = await dataSource.getRepository(Product).save({
      sku: 'TEST-1',
      name: 'Test Product',
      unit: 'unit',
      lowStockThreshold: 5,
      status: EntityStatus.ACTIVE,
    });
    productId = product.id;
  });

  it('stock-in increases current stock', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );
    expect(await service.getCurrentStock(productId)).toBe(10);
  });

  it('stock-out decreases current stock', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );
    await service.recordStockOut(
      productId,
      { quantity: 4, occurredAt: '2026-08-02' },
      userId,
    );
    expect(await service.getCurrentStock(productId)).toBe(6);
  });

  // BR-021 / BR-041: this is the rule a bug here would violate most visibly.
  it('rejects a stock-out that would exceed current stock, and leaves stock unchanged', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 5, occurredAt: '2026-08-01' },
      userId,
    );
    await expect(
      service.recordStockOut(
        productId,
        { quantity: 6, occurredAt: '2026-08-02' },
        userId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await service.getCurrentStock(productId)).toBe(5);
  });

  // BR-013: mirrors the "inactive product blocks stock-in" case in the UI mockup's
  // own smoke test — same rule, now proven against the real database instead of an
  // in-memory array.
  it('rejects stock-in/out on an inactive product', async () => {
    await dataSource
      .getRepository(Product)
      .update(productId, { status: EntityStatus.INACTIVE });
    await expect(
      service.recordStockIn(
        productId,
        { quantity: 1, occurredAt: '2026-08-01' },
        userId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('adjustment sets stock to the counted quantity, computing the delta itself', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );
    const tx = await service.recordAdjustment(
      productId,
      {
        newQuantity: 7,
        occurredAt: '2026-08-02',
        reason: 'Stocktake correction',
      },
      userId,
    );
    expect(tx.quantityDelta).toBe(-3);
    expect(await service.getCurrentStock(productId)).toBe(7);
  });

  it('adjustment is allowed even on an inactive product', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );
    await dataSource
      .getRepository(Product)
      .update(productId, { status: EntityStatus.INACTIVE });
    await expect(
      service.recordAdjustment(
        productId,
        { newQuantity: 8, occurredAt: '2026-08-02', reason: 'Final count' },
        userId,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects an adjustment that matches the current count exactly (a no-op change)', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );
    await expect(
      service.recordAdjustment(
        productId,
        { newQuantity: 10, occurredAt: '2026-08-02', reason: 'No change' },
        userId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a transaction against a product that does not exist', async () => {
    await expect(
      service.recordStockIn(
        999999,
        { quantity: 1, occurredAt: '2026-08-01' },
        userId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // THE key test for this phase: proves the pessimistic row lock in recordStockOut
  // actually serializes concurrent writers instead of both reading the same stale
  // "current stock" and both succeeding. Without the lock, two parallel requests for
  // 8 units against a stock of 13 would both read 13, both see 8 <= 13, and both
  // succeed — leaving stock at -3, a direct BR-041 violation.
  it('does not oversell stock under concurrent stock-out requests for the same product', async () => {
    await service.recordStockIn(
      productId,
      { quantity: 13, occurredAt: '2026-08-01' },
      userId,
    );

    const attempt = (quantity: number) =>
      service
        .recordStockOut(
          productId,
          { quantity, occurredAt: '2026-08-02' },
          userId,
        )
        .then(() => 'fulfilled' as const)
        .catch((err: unknown) => {
          if (err instanceof ConflictException) return 'rejected' as const;
          throw err; // an unexpected error shouldn't be silently swallowed as "rejected"
        });

    const results = await Promise.all([attempt(8), attempt(8)]);

    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
    const finalStock = await service.getCurrentStock(productId);
    expect(finalStock).toBe(5); // 13 - 8, never negative
    expect(finalStock).toBeGreaterThanOrEqual(0);
  });
});
