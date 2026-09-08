import { DataSource } from 'typeorm';
import { AdjustmentRequestStatus } from '../common/enums/adjustment-request-status.enum';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { createTestDataSource } from '../database/test-data-source';
import { AdjustmentRequest } from '../adjustments/adjustment-request.entity';
import { AdjustmentsService } from '../adjustments/adjustments.service';
import { Product } from '../products/product.entity';
import { User } from '../users/user.entity';
import { InventoryService } from './inventory.service';
import { InventoryTransaction } from './inventory-transaction.entity';

// INTEGRATION, not unit: Phase 23 (docs/phase-23-plan.md §1) materialises current
// stock as `products.current_stock` and keeps it honest by having
// InventoryService.insertTransaction *recompute it from the product's full history*
// on every write, under the pessimistic product-row lock. BR-042 ("current stock is
// always reproducible by replaying the full transaction history") and BR-043 (the
// write-path invariant) can only be proven against a real database: that the column
// equals a fresh SUM after a battery of mixed writes, that it self-heals if corrupted,
// that a concurrent writer's recompute sees the other's committed row, and that the
// one-shot backfill computes the same thing.
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('products.current_stock materialisation (integration, Phase 23)', () => {
  let dataSource: DataSource;
  let inventory: InventoryService;
  let adjustments: AdjustmentsService;
  let userId: number;
  let ownerId: number;
  let staff: { id: number; role: UserRole };
  let owner: { id: number; role: UserRole };

  // The production expression, applied to the whole table — the migration backfill,
  // run-seed.ts, and (per-product) InventoryService.rewriteCurrentStock all run this.
  const BACKFILL_SQL = `
    UPDATE products SET current_stock = COALESCE(
      (SELECT SUM(quantity_delta) FROM inventory_transactions WHERE product_id = products.id), 0)`;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    inventory = new InventoryService(
      dataSource,
      dataSource.getRepository(InventoryTransaction),
    );
    adjustments = new AdjustmentsService(
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
    userId = s.id;
    ownerId = o.id;
    staff = { id: s.id, role: UserRole.Staff };
    owner = { id: o.id, role: UserRole.Owner };
  });

  async function makeProduct(sku: string): Promise<number> {
    const p = await dataSource.getRepository(Product).save({
      sku,
      name: `Product ${sku}`,
      unit: 'unit',
      status: EntityStatus.ACTIVE,
    });
    return p.id;
  }

  // Reads the stored column and a fresh replay of history for every product, and
  // asserts they are equal — the BR-042/BR-043 invariant.
  async function assertAllReconciled(): Promise<
    { id: number; current_stock: number; sum: number }[]
  > {
    const rows: { id: number; current_stock: number; sum: string }[] =
      await dataSource.query(`
        SELECT p.id,
               p.current_stock,
               COALESCE(
                 (SELECT SUM(quantity_delta) FROM inventory_transactions
                   WHERE product_id = p.id), 0) AS sum
          FROM products p
         ORDER BY p.id`);
    for (const r of rows) {
      expect(Number(r.current_stock)).toBe(Number(r.sum));
    }
    return rows.map((r) => ({
      id: r.id,
      current_stock: Number(r.current_stock),
      sum: Number(r.sum),
    }));
  }

  it('a product with no transactions has current_stock 0', async () => {
    await makeProduct('EMPTY');
    const [row] = await assertAllReconciled();
    expect(row.current_stock).toBe(0);
    const view = await inventory.getCurrentStock(row.id);
    expect(view).toBe(0);
  });

  it('every write path leaves current_stock equal to a fresh replay of history (BR-042/BR-043)', async () => {
    const a = await makeProduct('A');
    const b = await makeProduct('B');
    const c = await makeProduct('C');

    await inventory.recordStockIn(
      a,
      { quantity: 40, occurredAt: '2026-08-01' },
      userId,
    );
    await inventory.recordStockOut(
      a,
      { quantity: 12, occurredAt: '2026-08-02' },
      userId,
    );
    await inventory.recordStockIn(
      a,
      { quantity: 5, occurredAt: '2026-08-03' },
      userId,
    );
    // Immediate (Owner) adjustment.
    await inventory.recordAdjustment(
      a,
      { newQuantity: 30, occurredAt: '2026-08-04', reason: 'Stocktake' },
      ownerId,
    );

    await inventory.recordStockIn(
      b,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );

    // Approved (Staff-requested) adjustment via the two-writes-one-transaction path.
    await inventory.recordStockIn(
      c,
      { quantity: 8, occurredAt: '2026-08-01' },
      userId,
    );
    const submitted = await adjustments.submit(
      c,
      { newQuantity: 20, occurredAt: '2026-08-02', reason: 'Recount' },
      staff,
    );
    if (submitted.outcome !== 'requested')
      throw new Error('expected a request');
    await adjustments.resolve(
      submitted.request.id,
      { status: AdjustmentRequestStatus.APPROVED },
      owner,
    );

    const rows = await assertAllReconciled();
    expect(rows).toEqual([
      { id: a, current_stock: 30, sum: 30 },
      { id: b, current_stock: 10, sum: 10 },
      { id: c, current_stock: 20, sum: 20 },
    ]);
  });

  it('a write recomputes current_stock from history — it does not trust the stored value', async () => {
    const p = await makeProduct('HEAL');
    await inventory.recordStockIn(
      p,
      { quantity: 10, occurredAt: '2026-08-01' },
      userId,
    );
    expect((await assertAllReconciled())[0].current_stock).toBe(10);

    // Corrupt the stored column directly.
    await dataSource.query(
      'UPDATE products SET current_stock = 999 WHERE id = $1',
      [p],
    );

    // One more movement through the service — a stock-in, which does not read current
    // stock to validate — and the column is rewritten from history, not `999 + delta`.
    await inventory.recordStockIn(
      p,
      { quantity: 3, occurredAt: '2026-08-02' },
      userId,
    );

    const [row] = await assertAllReconciled();
    expect(row.current_stock).toBe(13);
  });

  it('concurrent stock-outs leave current_stock equal to the replay (recompute rides the same lock)', async () => {
    const p = await makeProduct('RACE');
    await inventory.recordStockIn(
      p,
      { quantity: 13, occurredAt: '2026-08-01' },
      userId,
    );

    const attempt = (quantity: number) =>
      inventory
        .recordStockOut(p, { quantity, occurredAt: '2026-08-02' }, userId)
        .then(() => 'fulfilled' as const)
        .catch(() => 'rejected' as const);

    const results = await Promise.all([attempt(8), attempt(8)]);
    expect(results.filter((r) => r === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);

    const [row] = await assertAllReconciled();
    expect(row.current_stock).toBe(5); // 13 - 8, never negative
  });

  it('the one-shot backfill computes SUM(quantity_delta) per product, 0 when none', async () => {
    const withHistory = await makeProduct('BF1');
    const empty = await makeProduct('BF2');

    // Insert history directly, then wipe the column so only the backfill can set it.
    await dataSource.query(
      `INSERT INTO inventory_transactions
         (product_id, type, quantity_delta, occurred_at, recorded_by_user_id, reason)
       VALUES ($1, 'stock_in', 30, '2026-07-01', $2, NULL),
              ($1, 'stock_out', -11, '2026-07-02', $2, NULL),
              ($1, 'adjustment', 4, '2026-07-03', $2, 'Recount')`,
      [withHistory, userId],
    );
    await dataSource.query('UPDATE products SET current_stock = -1');

    await dataSource.query(BACKFILL_SQL);

    const rows = await assertAllReconciled();
    expect(rows).toEqual([
      { id: withHistory, current_stock: 23, sum: 23 },
      { id: empty, current_stock: 0, sum: 0 },
    ]);
  });
});
