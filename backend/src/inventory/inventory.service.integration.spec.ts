import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { TransactionType } from '../common/enums/transaction-type.enum';
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

  // Inserts rows directly through the repository (not the locking write path) — the
  // read tests below want exact control over occurred_at and a predictable id sequence
  // (1..N after the beforeEach TRUNCATE ... RESTART IDENTITY). Shared by the
  // "bounded reads" and "?days= window" blocks.
  async function seedTransactions(
    count: number,
    opts: { occurredAt?: string; productId?: number } = {},
  ): Promise<void> {
    const repo = dataSource.getRepository(InventoryTransaction);
    const rows = Array.from({ length: count }, () =>
      repo.create({
        productId: opts.productId ?? productId,
        type: TransactionType.STOCK_IN,
        quantityDelta: 1,
        occurredAt: new Date(opts.occurredAt ?? '2026-08-01'),
        recordedByUserId: userId,
        supplierId: null,
        reason: null,
      }),
    );
    // save([]) inserts in array order, so ids ascend with the loop.
    await repo.save(rows);
  }

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

  // ------------------------------------------------------------ Phase 11: bounded reads --
  // docs/phase-11-plan.md §5. Inserts rows directly through the repository (not the
  // locking write path) — these are read tests, and direct inserts give exact control
  // over occurred_at and a predictable id sequence (1..N after the beforeEach
  // TRUNCATE ... RESTART IDENTITY).
  describe('bounded reads', () => {
    // THE headline test for the phase: a LIMIT over `occurred_at DESC` alone is a
    // lottery among the rows tied on that column, and on this table a whole business
    // day is one tie. `addOrderBy('tx.id','DESC')` is what makes the cut deterministic.
    // Verified by removing that addOrderBy on a scratch branch and watching this go
    // red — a test that passes on both trees proves nothing (Phase 10 §5's lesson).
    it('returns a deterministic top-N when every row shares one occurred_at (the id tie-break)', async () => {
      const p2 = await dataSource.getRepository(Product).save({
        sku: 'TEST-2',
        name: 'Test Product 2',
        unit: 'unit',
        status: EntityStatus.ACTIVE,
      });
      const p3 = await dataSource.getRepository(Product).save({
        sku: 'TEST-3',
        name: 'Test Product 3',
        unit: 'unit',
        status: EntityStatus.ACTIVE,
      });
      // 30 rows, ids 1..30, all on the same business day, spread across three products.
      for (const pid of [productId, p2.id, p3.id]) {
        await seedTransactions(10, {
          productId: pid,
          occurredAt: '2026-08-15',
        });
      }

      const first = await service.listAll({ limit: 10 });
      const firstIds = first.rows.map((r) => r.id);

      // Stable across repeated calls...
      for (let i = 0; i < 3; i++) {
        const again = await service.listAll({ limit: 10 });
        expect(again.rows.map((r) => r.id)).toEqual(firstIds);
      }
      // ...and specifically the ten highest ids, newest-insertion-first — not just
      // *some* stable ten (which physical row order could fake on a small table).
      expect(firstIds).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
      expect(first.truncated).toBe(true);
    });

    it('caps at the default of 100, and honours an explicit limit up to the max', async () => {
      await seedTransactions(150);

      const def = await service.listAll({});
      expect(def.rows).toHaveLength(100);
      expect(def.truncated).toBe(true);

      const max = await service.listAll({ limit: 500 });
      expect(max.rows).toHaveLength(150);
      expect(max.truncated).toBe(false);
    });

    it('reports truncation from the limit+1 probe, including its off-by-one boundary', async () => {
      await seedTransactions(150);

      // Exactly as many rows as asked for: the probe row does not exist, no flag.
      const exact = await service.listAll({ limit: 150 });
      expect(exact.rows).toHaveLength(150);
      expect(exact.truncated).toBe(false);

      // One fewer: the 150th row is the probe row that came back — flag set.
      const under = await service.listAll({ limit: 149 });
      expect(under.rows).toHaveLength(149);
      expect(under.truncated).toBe(true);
    });

    it('listForProduct is bounded and tie-broken the same way', async () => {
      await seedTransactions(120, { occurredAt: '2026-08-15' });

      const def = await service.listForProduct(productId, {});
      expect(def.rows).toHaveLength(100);
      expect(def.truncated).toBe(true);
      expect(def.rows.map((r) => r.id)).toEqual(
        [...def.rows.map((r) => r.id)].sort((a, b) => b - a),
      );

      const all = await service.listForProduct(productId, { limit: 500 });
      expect(all.rows).toHaveLength(120);
      expect(all.truncated).toBe(false);
    });

    // Pins that the dashboard's integer did not change meaning when its mechanism did
    // (a second full read → a COUNT(*)).
    it('countSince matches the row count the old full read would have produced', async () => {
      await seedTransactions(40, {
        occurredAt: new Date().toISOString().slice(0, 10),
      });
      await seedTransactions(25, { occurredAt: '2020-01-01' }); // outside any recent window

      const counted = await service.countSince(7);
      const viaList = await service.listAll({ days: 7, limit: 500 });
      expect(counted).toBe(viaList.rows.length);
      expect(counted).toBe(40);
    });
  });

  // ------------------------------------------- Phase 11 review: the `days=N` window --
  // The contract (docs/api.md, common/days-cutoff.ts): `days=N` covers exactly N
  // calendar dates ending with today. For days=7 that is today plus the previous six,
  // so a row dated six days ago is IN and one dated seven days ago is OUT.
  //
  // Two properties are pinned here, and it is worth being exact about which historical
  // bug each one catches — one of them cannot be reproduced in this suite at all:
  //   1. the boundary. The intermediate version subtracted `days` rather than
  //      `days - 1` and returned eight dates for `days=7`. All three tests below go red
  //      against it — verified by reverting the subtraction and re-running.
  //   2. hour-independence. The ORIGINAL version kept the current time of day on the
  //      cutoff. That defect only ever surfaced where the local date runs ahead of the
  //      UTC date `occurred_at` is stored under — i.e. the small hours of a
  //      positive-offset zone such as this project's UTC+7. A Jest file cannot move the
  //      process zone (docs/phase-10-plan.md §5 established that `process.env.TZ` does
  //      not take effect under this setup), and CI runs at UTC, where the original
  //      formula happened to be correct at every hour. So the third test does NOT
  //      reproduce that original bug; it pins hour-independence as a property the
  //      cutoff must have, and it does go red against the `days`-not-`days - 1`
  //      version. The zone-dependence itself is argued and swept in
  //      common/days-cutoff.ts rather than tested here.
  describe('the ?days= window is N calendar dates ending today', () => {
    // Pinned so the boundary is deterministic whenever the suite runs. Date is faked;
    // every timer/microtask API is left real so the pg pool and promise scheduling are
    // untouched.
    const pinNow = (iso: string) =>
      jest.useFakeTimers({
        now: new Date(iso),
        doNotFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'setImmediate',
          'clearImmediate',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
        ],
      });

    afterEach(() => jest.useRealTimers());

    const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
    const daysAgo = (from: Date, n: number): Date => {
      const d = new Date(from);
      d.setDate(d.getDate() - n);
      return d;
    };

    it('includes today and the previous six dates, and excludes the seventh', async () => {
      const NOW = new Date('2026-08-27T12:00:00Z');
      pinNow(NOW.toISOString());

      // One transaction on each of the eight candidate dates, so the cut is visible
      // rather than inferred from an absence.
      for (const back of [0, 1, 2, 3, 4, 5, 6, 7]) {
        await seedTransactions(1, { occurredAt: isoDate(daysAgo(NOW, back)) });
      }

      const list = await service.listAll({ days: 7, limit: 500 });
      const dates = list.rows.map((r) => isoDate(r.occurredAt)).sort();

      // Exactly seven dates, and exactly which seven.
      expect(dates).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((b) => isoDate(daysAgo(NOW, b))).sort(),
      );
      expect(dates).toContain(isoDate(NOW)); // today is in
      expect(dates).toContain(isoDate(daysAgo(NOW, 6))); // six days ago is in
      expect(dates).not.toContain(isoDate(daysAgo(NOW, 7))); // seven days ago is out

      // countSince applies the identical cutoff — one row per date, so seven.
      expect(await service.countSince(7)).toBe(7);
    });

    it('days=1 is today alone', async () => {
      const NOW = new Date('2026-08-27T12:00:00Z');
      pinNow(NOW.toISOString());

      await seedTransactions(1, { occurredAt: isoDate(NOW) });
      await seedTransactions(1, { occurredAt: isoDate(daysAgo(NOW, 1)) });

      const list = await service.listAll({ days: 1, limit: 500 });
      expect(list.rows.map((r) => isoDate(r.occurredAt))).toEqual([
        isoDate(NOW),
      ]);
      expect(await service.countSince(1)).toBe(1);
    });

    it('returns the same window at every hour of the request day', async () => {
      // The regression guard for the ORIGINAL defect: the old cutoff carried the
      // current clock, so the boundary date fell in or out depending on the hour.
      // Same seed, four instants spread across one calendar day, one expected answer.
      //
      // The window is a *local*-calendar-day concept and correctly rolls forward at
      // local midnight, so the swept instants must all fall on the same local date.
      // This file runs at UTC (CI) or UTC+7 (dev) — process zone can't be moved here
      // (docs/phase-10-plan.md §5) — so the hours stay below 17:00Z, which is still
      // the 27th in both of those zones.
      const DATE = '2026-08-27';
      const seedAt = new Date(`${DATE}T12:00:00Z`);
      for (const back of [0, 6, 7]) {
        await seedTransactions(1, {
          occurredAt: isoDate(daysAgo(seedAt, back)),
        });
      }

      const expected = [0, 6].map((b) => isoDate(daysAgo(seedAt, b))).sort();

      for (const hour of ['00:30', '06:00', '12:00', '16:30']) {
        jest.useRealTimers();
        pinNow(`${DATE}T${hour}:00Z`);
        const list = await service.listAll({ days: 7, limit: 500 });
        expect(list.rows.map((r) => isoDate(r.occurredAt)).sort()).toEqual(
          expected,
        );
        expect(await service.countSince(7)).toBe(2);
      }
    });
  });
});
