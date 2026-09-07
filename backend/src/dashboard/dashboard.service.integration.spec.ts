import { DataSource } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { TransactionType } from '../common/enums/transaction-type.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { createTestDataSource } from '../database/test-data-source';
import { InventoryService } from '../inventory/inventory.service';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { User } from '../users/user.entity';
import { DashboardService } from './dashboard.service';

// INTEGRATION, not unit: Phase 19 (docs/phase-19-plan.md §1) moves the dashboard's
// stock counts into one SQL query — the shared `joinCurrentStock` grouped-subquery
// join — replacing `productsRepository.find()` + a second
// `inventoryService.getCurrentStockMap()` round-trip. A mock repository cannot prove
// the join sums the deltas, that a product with no transactions reads 0, or that the
// name ordering `needsAttention` now relies on is really applied. Only a real
// database can. dashboard.service.spec.ts keeps the fast BR-062 unit coverage.
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('DashboardService.getSummary (integration, Phase 19)', () => {
  let dataSource: DataSource;
  let service: DashboardService;
  let userId: number;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    const inventory = new InventoryService(
      dataSource,
      dataSource.getRepository(InventoryTransaction),
    );
    service = new DashboardService(
      dataSource.getRepository(Product),
      inventory,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const user = await dataSource.getRepository(User).save({
      name: 'Test User',
      role: UserRole.Staff,
      email: 'test-user@example.com',
      passwordHash: 'unused-in-this-test',
    });
    userId = user.id;
  });

  // Direct inserts, not the locking write path — read tests wanting exact control
  // over stock. `deltas` seeds one transaction per entry, so a multi-entry list
  // proves the query SUMs rather than reads a single row. Omit for "no history".
  async function makeProduct(opts: {
    sku: string;
    name: string;
    status?: EntityStatus;
    threshold?: number | null;
    deltas?: number[];
  }): Promise<Product> {
    const product = await dataSource.getRepository(Product).save({
      sku: opts.sku,
      name: opts.name,
      unit: 'unit',
      status: opts.status ?? EntityStatus.ACTIVE,
      lowStockThreshold: opts.threshold ?? null,
      categoryId: null,
    });
    if (opts.deltas?.length) {
      await dataSource.getRepository(InventoryTransaction).save(
        opts.deltas.map((d) => ({
          productId: product.id,
          type: d >= 0 ? TransactionType.STOCK_IN : TransactionType.STOCK_OUT,
          quantityDelta: d,
          occurredAt: new Date('2026-09-01'),
          recordedByUserId: userId,
          supplierId: null,
          reason: null,
        })),
      );
    }
    return product;
  }

  describe('the counts, over a mixed catalogue', () => {
    beforeEach(async () => {
      await makeProduct({
        sku: 'A',
        name: 'Anchor',
        threshold: 5,
        deltas: [15, 5],
      }); // active, stock 20 → normal
      await makeProduct({
        sku: 'B',
        name: 'Beacon',
        threshold: 5,
        deltas: [3],
      }); // active, low
      await makeProduct({
        sku: 'C',
        name: 'Cable',
        threshold: 5,
        deltas: [10, -10],
      }); // active, stock 0 → low AND out
      await makeProduct({ sku: 'D', name: 'Dowel', threshold: null }); // active, no history → out, never low
      await makeProduct({
        sku: 'E',
        name: 'Ember',
        status: EntityStatus.INACTIVE,
        threshold: 2,
        deltas: [1],
      }); // inactive + low
    });

    it('sums deltas per product and derives the four counts', async () => {
      const summary = await service.getSummary();

      expect(summary.activeProductsCount).toBe(4);
      expect(summary.inactiveProductsCount).toBe(1);
      // low spans active + inactive, exactly as before this phase — Beacon, Cable,
      // Ember. Dowel has no threshold so it is never flagged low (BR-061).
      expect(summary.lowStockCount).toBe(3);
      // out is currentStock <= 0 — Cable (summed to 0) and Dowel (no history).
      expect(summary.outOfStockCount).toBe(2);
    });

    it('needsAttention carries each row real current stock, name-ordered', async () => {
      const summary = await service.getSummary();

      expect(summary.needsAttention.map((p) => p.name)).toEqual([
        'Beacon',
        'Cable',
        'Ember',
      ]);
      const byName = Object.fromEntries(
        summary.needsAttention.map((p) => [p.name, p]),
      );
      expect(byName.Beacon.currentStock).toBe(3);
      expect(byName.Cable.currentStock).toBe(0);
      expect(byName.Ember.currentStock).toBe(1);
    });
  });

  it('a product with no transactions is stock 0 (out-of-stock), not missing', async () => {
    await makeProduct({ sku: 'Z', name: 'Zero', threshold: null });

    const summary = await service.getSummary();

    expect(summary.activeProductsCount).toBe(1);
    expect(summary.outOfStockCount).toBe(1);
    expect(summary.lowStockCount).toBe(0);
  });

  it('needsAttention is capped at 5, taking the first low-stock products by name', async () => {
    // Seven low-stock products, named out of alphabetical insertion order.
    for (const name of [
      'Golf',
      'Alpha',
      'Foxtrot',
      'Bravo',
      'Echo',
      'Delta',
      'Charlie',
    ]) {
      await makeProduct({ sku: name, name, threshold: 5, deltas: [1] });
    }

    const summary = await service.getSummary();

    expect(summary.lowStockCount).toBe(7);
    expect(summary.needsAttention.map((p) => p.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
    ]);
  });
});
