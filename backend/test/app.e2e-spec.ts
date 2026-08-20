// Must run before any other import pulls in ConfigModule — @nestjs/config reads
// process.env at module-init time and never overwrites a key that's already set, so
// this has to land first to redirect the whole app at the dedicated e2e database
// (see tools/README.md) instead of the dev database with its seeded demo data.
process.env.DB_DATABASE = 'smart_inventory_e2e';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

// An E2E (end-to-end) test is the outermost, slowest, most realistic kind: it starts
// the actual Nest application — real HTTP layer, real ValidationPipe, real exception
// filter, real Postgres — and talks to it only through supertest's HTTP calls, the
// same way the frontend (or curl) would. Compare with:
//  - suppliers.service.spec.ts: a unit test, mocked repository, no HTTP, no DB.
//  - inventory.service.integration.spec.ts: calls the service directly against a
//    real DB, skipping HTTP/validation.
// This file is the one place all three layers are proven to work together.
describe('Smart Inventory Manager API (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts exactly — an e2e test that skips this would validate against a
    // different (looser) pipeline than production actually runs.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
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
    await dataSource.query(
      `INSERT INTO users (name, role) VALUES ('E2E User', 'Staff')`,
    );
  });

  it('rejects an invalid product payload with 400 and a useful message', async () => {
    const res = await request(app.getHttpServer())
      .post('/products')
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('name')]),
    );
  });

  it('creates a product, then reflects it in the list with currentStock = 0', async () => {
    const create = await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    expect(create.status).toBe(201);

    const list = await request(app.getHttpServer()).get('/products');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        sku: 'W-1',
        currentStock: 0,
        lowStock: false,
        outOfStock: true,
      }),
    ]);
  });

  it('rejects a duplicate SKU with 409', async () => {
    await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const dup = await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'Other', sku: 'W-1', unit: 'each' });
    expect(dup.status).toBe(409);
  });

  it('runs a full stock-in → stock-out → history round trip through real HTTP', async () => {
    const product = await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'Widget', sku: 'W-1', unit: 'each', lowStockThreshold: 5 });
    const id = product.body.id;

    await request(app.getHttpServer())
      .post(`/products/${id}/stock-in`)
      .send({ quantity: 10, occurredAt: '2026-08-01' })
      .expect(201);

    const afterIn = await request(app.getHttpServer()).get(`/products/${id}`);
    expect(afterIn.body.currentStock).toBe(10);

    await request(app.getHttpServer())
      .post(`/products/${id}/stock-out`)
      .send({ quantity: 3, occurredAt: '2026-08-02' })
      .expect(201);

    const afterOut = await request(app.getHttpServer()).get(`/products/${id}`);
    expect(afterOut.body.currentStock).toBe(7);
    expect(afterOut.body.lowStock).toBe(false);

    const history = await request(app.getHttpServer()).get(
      `/products/${id}/transactions`,
    );
    expect(history.body).toHaveLength(2);
    expect(history.body[0].type).toBe('stock_out'); // newest first
  });

  it('a pipe-rejected request never leaks a stack trace, over real HTTP', async () => {
    // A malformed :id param makes ParseIntPipe throw BadRequestException — an
    // HttpException, so AllExceptionsFilter takes its *first* branch (pass the
    // exception's own response through), not the fallback branch for unanticipated
    // errors. This still proves something real (the pipe → filter → response chain
    // is wired correctly over actual HTTP, and even this "normal" rejection path
    // doesn't leak anything), but NOT that the fallback branch works — a plain,
    // non-HttpException Error can't be triggered through any real route in this app,
    // so that branch is covered directly against the filter instead: see
    // all-exceptions.filter.spec.ts.
    const res = await request(app.getHttpServer()).get(
      '/products/not-a-number',
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s.+\(.+:\d+:\d+\)/); // no stack frame text
  });
});
