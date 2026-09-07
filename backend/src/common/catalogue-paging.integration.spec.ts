import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { Category } from '../categories/category.entity';
import { EntityStatus } from './enums/entity-status.enum';
import { Paged } from './pagination';
import { UserRole } from './enums/user-role.enum';
import { createTestDataSource } from '../database/test-data-source';
import { Product } from '../products/product.entity';
import { SuppliersService } from '../suppliers/suppliers.service';
import { Supplier } from '../suppliers/supplier.entity';
import { UsersService } from '../users/users.service';
import { User } from '../users/user.entity';

// INTEGRATION. Phase 14's three "easy" catalogue routes — suppliers, categories,
// users — take `skip`/`take`/count with no query rewrite (only products needed Fork
// B). One spec each, consolidated here because the assertion is identical for all
// three: no paging params → the full list, unchanged; a paging param → a
// `{ items, page, pageSize, total }` window where `total` counts the whole set.
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('catalogue list paging — suppliers / categories / users (integration)', () => {
  let dataSource: DataSource;
  let suppliers: SuppliersService;
  let categories: CategoriesService;
  let users: UsersService;

  const auditStub = { record: jest.fn() } as unknown as AuditService;
  const configStub = {} as ConfigService;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    suppliers = new SuppliersService(
      dataSource.getRepository(Supplier),
      auditStub,
    );
    categories = new CategoriesService(
      dataSource.getRepository(Category),
      auditStub,
    );
    users = new UsersService(
      dataSource.getRepository(User),
      configStub as ConfigService<never, true>,
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
  });

  function asPage<T>(result: T[] | Paged<T>): Paged<T> {
    if (Array.isArray(result))
      throw new Error('expected a paged envelope, got a bare array');
    return result;
  }

  describe('suppliers', () => {
    beforeEach(async () => {
      const repo = dataSource.getRepository(Supplier);
      for (let i = 0; i < 25; i++) {
        await repo.save({
          name: `Supplier ${String(i).padStart(2, '0')}`,
          status: EntityStatus.ACTIVE,
        });
      }
    });

    it('no paging params → all 25, name order', async () => {
      const rows = await suppliers.findAll({});
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(25);
      expect((rows as Supplier[])[0].name).toBe('Supplier 00');
    });

    it('page 2 of pageSize 10 → rows 11–20, total 25', async () => {
      const page = asPage(await suppliers.findAll({ page: 2, pageSize: 10 }));
      expect(page).toMatchObject({ page: 2, pageSize: 10, total: 25 });
      expect(page.items.map((s) => s.name)).toEqual([
        'Supplier 10',
        'Supplier 11',
        'Supplier 12',
        'Supplier 13',
        'Supplier 14',
        'Supplier 15',
        'Supplier 16',
        'Supplier 17',
        'Supplier 18',
        'Supplier 19',
      ]);
    });

    it('total counts the filtered set, not the table', async () => {
      const page = asPage(
        await suppliers.findAll({ search: 'Supplier 1', page: 1, pageSize: 5 }),
      );
      expect(page.total).toBe(10); // 'Supplier 10'..'Supplier 19'
      expect(page.items).toHaveLength(5);
    });

    it('a page past the end is empty with the real total', async () => {
      const page = asPage(await suppliers.findAll({ page: 9, pageSize: 10 }));
      expect(page).toMatchObject({ total: 25 });
      expect(page.items).toEqual([]);
    });
  });

  describe('categories', () => {
    beforeEach(async () => {
      const repo = dataSource.getRepository(Category);
      for (let i = 0; i < 12; i++) {
        await repo.save({ name: `Category ${String(i).padStart(2, '0')}` });
      }
    });

    it('no query arg at all → all 12 (the loadReferenceData path)', async () => {
      const rows = await categories.findAll();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(12);
    });

    it('paged → window plus total', async () => {
      const page = asPage(await categories.findAll({ page: 1, pageSize: 5 }));
      expect(page).toMatchObject({ page: 1, pageSize: 5, total: 12 });
      expect(page.items.map((c) => c.name)).toEqual([
        'Category 00',
        'Category 01',
        'Category 02',
        'Category 03',
        'Category 04',
      ]);
    });

    // Phase 17 (docs/phase-17-plan.md §2): the paged branch carries a server-computed
    // `productCount` per row, so the Categories admin screen stops fetching the whole
    // product catalogue to count client-side.
    describe('productCount (Phase 17)', () => {
      beforeEach(async () => {
        const catRepo = dataSource.getRepository(Category);
        const prodRepo = dataSource.getRepository(Product);
        const c0 = await catRepo.findOneByOrFail({ name: 'Category 00' });
        const c1 = await catRepo.findOneByOrFail({ name: 'Category 01' });
        // 3 products in Category 00, 1 in Category 01, 0 elsewhere; plus one
        // uncategorised product that must not be counted against any row.
        for (let i = 0; i < 3; i++) {
          await prodRepo.save({
            sku: `C0-${i}`,
            name: `C0 product ${i}`,
            unit: 'ea',
            categoryId: c0.id,
          });
        }
        await prodRepo.save({
          sku: 'C1-0',
          name: 'C1 product 0',
          unit: 'ea',
          categoryId: c1.id,
        });
        await prodRepo.save({
          sku: 'NONE-0',
          name: 'Uncategorised',
          unit: 'ea',
          categoryId: null,
        });
      });

      it('the paged rows carry the right count, including 0', async () => {
        const page = asPage(
          await categories.findAll({ page: 1, pageSize: 12 }),
        );
        const byName = Object.fromEntries(
          page.items.map((c) => [c.name, c.productCount]),
        );
        expect(byName['Category 00']).toBe(3);
        expect(byName['Category 01']).toBe(1);
        expect(byName['Category 02']).toBe(0);
        // The uncategorised product is counted against no row — every count sums to
        // the categorised products only.
        const summed = page.items.reduce((n, c) => n + c.productCount, 0);
        expect(summed).toBe(4);
      });

      it('productCount is a real number, not a bigint string from pg', async () => {
        const page = asPage(await categories.findAll({ page: 1, pageSize: 1 }));
        expect(typeof page.items[0].productCount).toBe('number');
      });

      it('the no-param path returns bare Category rows with no productCount', async () => {
        const rows = await categories.findAll();
        expect(Array.isArray(rows)).toBe(true);
        for (const row of rows as Category[]) {
          expect(row).not.toHaveProperty('productCount');
        }
      });
    });
  });

  describe('users', () => {
    beforeEach(async () => {
      const repo = dataSource.getRepository(User);
      for (let i = 0; i < 8; i++) {
        await repo.save({
          name: `User ${i}`,
          role: i === 0 ? UserRole.Owner : UserRole.Staff,
          email: `user${i}@example.com`,
          passwordHash: 'unused',
        });
      }
    });

    it('no paging params → all 8, id order', async () => {
      const rows = await users.findAll({});
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(8);
    });

    it('paged → window plus total', async () => {
      const page = asPage(await users.findAll({ page: 2, pageSize: 3 }));
      expect(page).toMatchObject({ page: 2, pageSize: 3, total: 8 });
      expect(page.items).toHaveLength(3);
      expect(page.items[0].email).toBe('user3@example.com');
    });
  });
});
