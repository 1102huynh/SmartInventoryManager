// Must run before any other import pulls in ConfigModule — see app.e2e-spec.ts for
// why this has to be the very first thing in the file.
process.env.DB_DATABASE = 'smart_inventory_e2e';

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
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('E2E User', 'Staff', 'e2e-user@example.com', $1)`,
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
});
