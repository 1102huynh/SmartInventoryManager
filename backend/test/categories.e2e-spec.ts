// Must run before any other import pulls in ConfigModule — see app.e2e-spec.ts for
// why this has to be the very first thing in the file.
process.env.DB_DATABASE = 'smart_inventory_e2e';
// Phase 8 (docs/phase-8-plan.md §5/§6): see app.e2e-spec.ts's comment — raised so
// this file's rapid-fire logins never trip the production-sized login throttle.
process.env.THROTTLE_LOGIN_LIMIT = '1000';
process.env.THROTTLE_LIMIT = '10000';

import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

// FR-005/phase-4-plan.md §5: Category CRUD over real HTTP, against a real database —
// in particular the one thing a mocked repository (categories.service.spec.ts)
// can't prove: that deleting a category a product currently references actually sets
// that product's categoryId to null via the schema's ON DELETE SET NULL foreign key,
// not just that application code intended it to.
const TEST_PASSWORD = 'e2e-test-password';

describe('Categories (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts exactly — see app.e2e-spec.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(
      new ClassSerializerInterceptor(app.get(Reflector)),
    );
    await app.init();
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    // Phase 5 (docs/phase-5-plan.md §5): this file drives category/product writes,
    // which are now Owner-only — 'owner' rather than 'staff'.
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('E2E User', 'owner', 'e2e-user@example.com', $1)`,
      [passwordHash],
    );
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'e2e-user@example.com', password: TEST_PASSWORD });
    token = login.body.accessToken;
  });

  function auth(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`);
  }

  it('creates a category and lists it', async () => {
    const create = await auth(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    expect(create.status).toBe(201);
    expect(create.body).toEqual(expect.objectContaining({ name: 'Beverages' }));

    const list = await auth(request(app.getHttpServer()).get('/categories'));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ name: 'Beverages' })]);
  });

  it('rejects a duplicate category name with 409', async () => {
    await auth(request(app.getHttpServer()).post('/categories')).send({
      name: 'Beverages',
    });
    const dup = await auth(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    expect(dup.status).toBe(409);
  });

  it('renames a category', async () => {
    const create = await auth(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    const id = create.body.id;

    const rename = await auth(
      request(app.getHttpServer()).patch(`/categories/${id}`),
    ).send({ name: 'Drinks' });
    expect(rename.status).toBe(200);
    expect(rename.body.name).toBe('Drinks');
  });

  // Phase 7 (docs/phase-7-plan.md §5): audit timestamps.
  it('list items include createdAt and updatedAt', async () => {
    await auth(request(app.getHttpServer()).post('/categories')).send({
      name: 'Beverages',
    });
    const list = await auth(request(app.getHttpServer()).get('/categories'));
    expect(list.status).toBe(200);
    expect(typeof list.body[0].createdAt).toBe('string');
    expect(typeof list.body[0].updatedAt).toBe('string');
  });

  it('renaming a category moves updatedAt and leaves createdAt fixed', async () => {
    const create = await auth(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    const id = create.body.id;
    const originalCreatedAt = create.body.createdAt;
    const originalUpdatedAt = create.body.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 50));

    const rename = await auth(
      request(app.getHttpServer()).patch(`/categories/${id}`),
    ).send({ name: 'Drinks' });
    expect(rename.status).toBe(200);
    expect(rename.body.createdAt).toBe(originalCreatedAt);
    expect(rename.body.updatedAt).not.toBe(originalUpdatedAt);
    expect(new Date(rename.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(originalUpdatedAt).getTime(),
    );
  });

  it("rejects a rename to another category's existing name with 409", async () => {
    await auth(request(app.getHttpServer()).post('/categories')).send({
      name: 'Beverages',
    });
    const second = await auth(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Snacks' });

    const rename = await auth(
      request(app.getHttpServer()).patch(`/categories/${second.body.id}`),
    ).send({ name: 'Beverages' });
    expect(rename.status).toBe(409);
  });

  it('renaming or deleting a nonexistent category returns 404', async () => {
    const rename = await auth(
      request(app.getHttpServer()).patch('/categories/999'),
    ).send({ name: 'Anything' });
    expect(rename.status).toBe(404);

    const del = await auth(
      request(app.getHttpServer()).delete('/categories/999'),
    );
    expect(del.status).toBe(404);
  });

  it("deleting a category a product references sets that product's categoryId to null (ON DELETE SET NULL)", async () => {
    const category = await auth(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    const categoryId = category.body.id;

    const product = await auth(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Coffee', sku: 'C-1', unit: 'each', categoryId });
    const productId = product.body.id;

    const del = await auth(
      request(app.getHttpServer()).delete(`/categories/${categoryId}`),
    );
    expect(del.status).toBe(204);

    const after = await auth(
      request(app.getHttpServer()).get(`/products/${productId}`),
    );
    expect(after.body.categoryId).toBeNull();
  });

  // Confirms @Public() wasn't accidentally left on CategoriesController from before
  // auth existed — every route, including the pre-existing GET, sits behind the
  // global JwtAuthGuard with no special-casing (phase-4-plan.md §5).
  it('rejects every category route with no token at all', async () => {
    const server = app.getHttpServer();
    expect((await request(server).get('/categories')).status).toBe(401);
    expect((await request(server).post('/categories')).status).toBe(401);
    expect((await request(server).patch('/categories/1')).status).toBe(401);
    expect((await request(server).delete('/categories/1')).status).toBe(401);
  });

  // Phase 14 (docs/phase-14-plan.md §5): optional `?page=&pageSize=`. With neither —
  // the `Store.loadReferenceData` path that fills the `CATEGORIES` cache — GET
  // /categories must stay a bare array of every row.
  describe('optional paging (Phase 14)', () => {
    async function seedCategories(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await auth(request(app.getHttpServer()).post('/categories'))
          .send({ name: `Category ${String(i).padStart(2, '0')}` })
          .expect(201);
      }
    }

    it('no paging param → a bare array of every category (the reference-cache contract)', async () => {
      await seedCategories(6);
      const res = await auth(request(app.getHttpServer()).get('/categories'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(6);
    });

    it('with a paging param → a { items, page, pageSize, total } envelope', async () => {
      await seedCategories(6);
      const res = await auth(
        request(app.getHttpServer()).get('/categories?page=1&pageSize=4'),
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);
      expect(res.body).toMatchObject({ page: 1, pageSize: 4, total: 6 });
      const items = res.body.items as Array<{ name: string }>;
      expect(items.map((c) => c.name)).toEqual([
        'Category 00',
        'Category 01',
        'Category 02',
        'Category 03',
      ]);
    });

    it('rejects a bad pageSize with 400', async () => {
      for (const qs of ['pageSize=0', 'pageSize=101', 'page=0']) {
        const res = await auth(
          request(app.getHttpServer()).get(`/categories?${qs}`),
        );
        expect(res.status).toBe(400);
      }
    });
  });

  // Phase 17 (docs/phase-17-plan.md §2): the paged envelope's items carry a
  // server-computed `productCount`; the bare-array (reference-cache) response does
  // not.
  describe('product count on the paged read (Phase 17)', () => {
    it('paged items carry a numeric productCount that tracks the catalogue', async () => {
      const bev = await auth(
        request(app.getHttpServer()).post('/categories'),
      ).send({ name: 'Beverages' });
      await auth(request(app.getHttpServer()).post('/categories')).send({
        name: 'Snacks',
      });
      for (const sku of ['B-1', 'B-2']) {
        await auth(request(app.getHttpServer()).post('/products'))
          .send({
            name: `Drink ${sku}`,
            sku,
            unit: 'each',
            categoryId: bev.body.id,
          })
          .expect(201);
      }

      const res = await auth(
        request(app.getHttpServer()).get('/categories?page=1&pageSize=10'),
      );
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{
        name: string;
        productCount: number;
      }>;
      const counts = Object.fromEntries(
        items.map((c) => [c.name, c.productCount]),
      );
      expect(counts).toEqual({ Beverages: 2, Snacks: 0 });
      expect(typeof counts.Beverages).toBe('number');
    });

    it('the bare-array response has no productCount key', async () => {
      await auth(request(app.getHttpServer()).post('/categories')).send({
        name: 'Beverages',
      });
      const res = await auth(request(app.getHttpServer()).get('/categories'));
      expect(res.status).toBe(200);
      expect(res.body[0]).not.toHaveProperty('productCount');
    });
  });
});
