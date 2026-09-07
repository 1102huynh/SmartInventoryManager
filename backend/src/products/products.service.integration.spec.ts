import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { Paged } from '../common/pagination';
import { TransactionType } from '../common/enums/transaction-type.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { createTestDataSource } from '../database/test-data-source';
import { InventoryService } from '../inventory/inventory.service';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { User } from '../users/user.entity';
import { AdjustmentRequest } from '../adjustments/adjustment-request.entity';
import { Category } from '../categories/category.entity';
import { Product } from './product.entity';
import { ProductsService, ProductWithStock } from './products.service';

// INTEGRATION, not unit: Phase 14's Fork B moves current-stock and `hasHistory` INTO
// `findAll`'s query (a grouped subquery join), and turns `?status=low`/`out` from a
// post-fetch `.filter()` into real WHERE conditions. A mock repository cannot prove
// the SQL is right — that the join sums the deltas, that the paged `low` set is the
// low-stock rows and not "the first pageSize by name, then filtered", that `total`
// counts the filtered set. Only a real database can.
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('ProductsService.findAll (integration, Phase 14)', () => {
  let dataSource: DataSource;
  let service: ProductsService;
  let userId: number;

  const auditStub = { record: jest.fn() } as unknown as AuditService;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    const inventory = new InventoryService(
      dataSource,
      dataSource.getRepository(InventoryTransaction),
    );
    service = new ProductsService(
      dataSource.getRepository(Product),
      dataSource.getRepository(AdjustmentRequest),
      inventory,
      auditStub,
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

  // Direct inserts (not the locking write path) — these are read tests wanting exact
  // control over stock and a predictable order.
  async function makeProduct(opts: {
    sku: string;
    name: string;
    status?: EntityStatus;
    threshold?: number | null;
    categoryId?: number | null;
    stock?: number; // net delta seeded as a single transaction; omit for "no history"
  }): Promise<Product> {
    const product = await dataSource.getRepository(Product).save({
      sku: opts.sku,
      name: opts.name,
      unit: 'unit',
      status: opts.status ?? EntityStatus.ACTIVE,
      lowStockThreshold: opts.threshold ?? null,
      categoryId: opts.categoryId ?? null,
    });
    if (opts.stock !== undefined) {
      // `quantity_delta <> 0` is a CHECK constraint, so a net stock of 0 with history
      // is seeded as an offsetting pair (+1 then -1) rather than a single zero row.
      const deltas =
        opts.stock === 0 ? [1, -1] : [opts.stock];
      await dataSource.getRepository(InventoryTransaction).save(
        deltas.map((d) => ({
          productId: product.id,
          type: d > 0 ? TransactionType.STOCK_IN : TransactionType.STOCK_OUT,
          quantityDelta: d,
          occurredAt: new Date('2026-08-01'),
          recordedByUserId: userId,
          supplierId: null,
          reason: null,
        })),
      );
    }
    return product;
  }

  function asArray(
    result: ProductWithStock[] | Paged<ProductWithStock>,
  ): ProductWithStock[] {
    if (Array.isArray(result)) return result;
    throw new Error('expected a bare array, got a paged envelope');
  }
  function asPage(
    result: ProductWithStock[] | Paged<ProductWithStock>,
  ): Paged<ProductWithStock> {
    if (Array.isArray(result))
      throw new Error('expected a paged envelope, got a bare array');
    return result;
  }

  describe('the Fork B rewrite preserves the unpaged result', () => {
    // A fixture where low / out / normal genuinely differ from active — the plan's
    // requirement (docs/phase-14-plan.md §5). Alphabetical by name so the expected
    // order is obvious.
    beforeEach(async () => {
      const cat = await dataSource
        .getRepository(Category)
        .save({ name: 'Cat A' });
      await makeProduct({
        sku: 'A',
        name: 'Anchor',
        threshold: 5,
        stock: 20,
        categoryId: cat.id,
      }); // normal
      await makeProduct({ sku: 'B', name: 'Beacon', threshold: 5, stock: 3 }); // low, not out
      await makeProduct({ sku: 'C', name: 'Cable', threshold: 5, stock: 0 }); // low AND out
      await makeProduct({ sku: 'D', name: 'Dowel', threshold: null }); // no history → out, never low (no threshold)
      await makeProduct({
        sku: 'E',
        name: 'Ember',
        status: EntityStatus.INACTIVE,
        threshold: 2,
        stock: 1,
      }); // inactive + low
    });

    it('returns every product in name order with correct computed fields', async () => {
      const rows = asArray(await service.findAll({}));
      expect(rows.map((r) => r.name)).toEqual([
        'Anchor',
        'Beacon',
        'Cable',
        'Dowel',
        'Ember',
      ]);

      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byName.Anchor).toMatchObject({
        currentStock: 20,
        lowStock: false,
        outOfStock: false,
        hasHistory: true,
      });
      expect(byName.Beacon).toMatchObject({
        currentStock: 3,
        lowStock: true,
        outOfStock: false,
        hasHistory: true,
      });
      expect(byName.Cable).toMatchObject({
        currentStock: 0,
        lowStock: true,
        outOfStock: true,
        hasHistory: true,
      });
      expect(byName.Dowel).toMatchObject({
        currentStock: 0,
        lowStock: false, // no threshold configured — BR-060/061
        outOfStock: true,
        hasHistory: false,
      });
      expect(byName.Ember).toMatchObject({
        currentStock: 1,
        lowStock: true,
        outOfStock: false,
        hasHistory: true,
      });
    });

    it('applies status=active / inactive as before', async () => {
      const active = asArray(await service.findAll({ status: 'active' }));
      expect(active.map((r) => r.name)).toEqual([
        'Anchor',
        'Beacon',
        'Cable',
        'Dowel',
      ]);
      const inactive = asArray(await service.findAll({ status: 'inactive' }));
      expect(inactive.map((r) => r.name)).toEqual(['Ember']);
    });

    it('status=low returns exactly the low-stock products (computed), status=out the out-of-stock ones', async () => {
      const low = asArray(await service.findAll({ status: 'low' }));
      expect(low.map((r) => r.name)).toEqual(['Beacon', 'Cable', 'Ember']);
      const out = asArray(await service.findAll({ status: 'out' }));
      expect(out.map((r) => r.name)).toEqual(['Cable', 'Dowel']);
    });

    it('filters by categoryId', async () => {
      const cat = await dataSource
        .getRepository(Category)
        .findOneByOrFail({ name: 'Cat A' });
      const rows = asArray(await service.findAll({ categoryId: cat.id }));
      expect(rows.map((r) => r.name)).toEqual(['Anchor']);
    });

    it('filters by search over name or sku', async () => {
      expect(
        asArray(await service.findAll({ search: 'able' })).map((r) => r.name),
      ).toEqual(['Cable']);
      expect(
        asArray(await service.findAll({ search: 'D' })).map((r) => r.name),
      ).toEqual(['Dowel']); // sku 'D'
    });
  });

  describe('optional paging', () => {
    // 40 products, 12 of them low-stock, interleaved by name so "first pageSize by
    // name then filter" would give a visibly wrong answer.
    beforeEach(async () => {
      for (let i = 0; i < 40; i++) {
        const low = i % 3 === 0; // 0,3,6,... → 14 of 40? no: floor(39/3)+1 = 14
        await makeProduct({
          sku: `P${String(i).padStart(2, '0')}`,
          name: `Product ${String(i).padStart(2, '0')}`,
          threshold: 5,
          stock: low ? 2 : 50,
        });
      }
    });

    it('no paging params → bare array of all 40', async () => {
      const rows = asArray(await service.findAll({}));
      expect(rows).toHaveLength(40);
    });

    it('page 1 of pageSize 10 → first 10 by name, total 40', async () => {
      const page = asPage(await service.findAll({ page: 1, pageSize: 10 }));
      expect(page).toMatchObject({ page: 1, pageSize: 10, total: 40 });
      expect(page.items).toHaveLength(10);
      expect(page.items[0].name).toBe('Product 00');
      expect(page.items[9].name).toBe('Product 09');
    });

    it('pageSize alone defaults page to 1; page alone defaults pageSize', async () => {
      const bySize = asPage(await service.findAll({ pageSize: 5 }));
      expect(bySize).toMatchObject({ page: 1, pageSize: 5, total: 40 });
      expect(bySize.items).toHaveLength(5);

      const byPage = asPage(await service.findAll({ page: 2 }));
      expect(byPage).toMatchObject({ page: 2, pageSize: 50, total: 40 });
      expect(byPage.items).toHaveLength(0); // page 2 of a 50-size window over 40 rows
    });

    it('status=low + paging pages the low-stock set, with total = all low matches (not "first pageSize then filter")', async () => {
      const lowCount = 14; // i % 3 === 0 for i in 0..39
      const p1 = asPage(
        await service.findAll({ status: 'low', page: 1, pageSize: 5 }),
      );
      expect(p1.total).toBe(lowCount);
      expect(p1.items).toHaveLength(5);
      expect(p1.items.every((r) => r.lowStock)).toBe(true);

      const p3 = asPage(
        await service.findAll({ status: 'low', page: 3, pageSize: 5 }),
      );
      expect(p3.total).toBe(lowCount);
      expect(p3.items).toHaveLength(4); // 14 - 10
      expect(p3.items.every((r) => r.lowStock)).toBe(true);
    });

    it('total is the count of the filtered set, not the table', async () => {
      const page = asPage(
        await service.findAll({ search: 'Product 1', page: 1, pageSize: 5 }),
      );
      // 'Product 10'..'Product 19' → 10 matches
      expect(page.total).toBe(10);
      expect(page.items).toHaveLength(5);
    });

    it('a page past the end is empty, not an error, and keeps the real total', async () => {
      const page = asPage(await service.findAll({ page: 99, pageSize: 10 }));
      expect(page).toMatchObject({ page: 99, pageSize: 10, total: 40 });
      expect(page.items).toEqual([]);
    });
  });
});
