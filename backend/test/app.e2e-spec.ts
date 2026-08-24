// Must run before any other import pulls in ConfigModule — @nestjs/config reads
// process.env at module-init time and never overwrites a key that's already set, so
// this has to land first to redirect the whole app at the dedicated e2e database
// (see tools/README.md) instead of the dev database with its seeded demo data.
process.env.DB_DATABASE = 'smart_inventory_e2e';
// Phase 8 (docs/phase-8-plan.md §5/§6): this suite logs in far more often, and far
// faster, than the production defaults (10 logins / 5 min) allow for — every test's
// beforeEach logs in as a seeded user, and Jest runs this file's tests back to back
// in seconds. A generously raised limit here keeps this file exercising its own
// behavior instead of tripping over Phase 8's throttle; auth.e2e-spec.ts overrides
// these same variables back down to actually test the throttle and the lockout.
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

// An E2E (end-to-end) test is the outermost, slowest, most realistic kind: it starts
// the actual Nest application — real HTTP layer, real ValidationPipe, real exception
// filter, real Postgres — and talks to it only through supertest's HTTP calls, the
// same way the frontend (or curl) would. Compare with:
//  - suppliers.service.spec.ts: a unit test, mocked repository, no HTTP, no DB.
//  - inventory.service.integration.spec.ts: calls the service directly against a
//    real DB, skipping HTTP/validation.
// This file is the one place all three layers are proven to work together.
//
// Phase 3: every write endpoint now sits behind the global JwtAuthGuard (see
// docs/phase-3-plan.md), so every test that hits one needs a real token — beforeEach
// below seeds one user and logs in as them, the same way a real client would, rather
// than reaching around auth. See auth.e2e-spec.ts for auth's own behavior in detail.
const TEST_PASSWORD = 'e2e-test-password';

describe('Smart Inventory Manager API (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;

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
    // Phase 5 (docs/phase-5-plan.md §5): this file drives product/supplier writes,
    // which are now Owner-only — 'owner' rather than 'staff', or the whole file
    // starts failing with 403 for the right reason in the wrong place.
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('E2E User', 'owner', 'e2e-user@example.com', $1)`,
      [passwordHash],
    );
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'e2e-user@example.com', password: TEST_PASSWORD });
    token = login.body.accessToken;
  });

  // Attach the same way the frontend's Store._request does — see
  // docs/phase-3-plan.md "Token transport".
  function auth(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`);
  }

  it('rejects an invalid product payload with 400 and a useful message', async () => {
    const res = await auth(request(app.getHttpServer()).post('/products')).send(
      { name: '' },
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('name')]),
    );
  });

  it('creates a product, then reflects it in the list with currentStock = 0', async () => {
    const create = await auth(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    expect(create.status).toBe(201);

    const list = await auth(request(app.getHttpServer()).get('/products'));
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
    await auth(request(app.getHttpServer()).post('/products')).send({
      name: 'Widget',
      sku: 'W-1',
      unit: 'each',
    });
    const dup = await auth(request(app.getHttpServer()).post('/products')).send(
      { name: 'Other', sku: 'W-1', unit: 'each' },
    );
    expect(dup.status).toBe(409);
  });

  it('runs a full stock-in → stock-out → history round trip through real HTTP', async () => {
    const product = await auth(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each', lowStockThreshold: 5 });
    const id = product.body.id;

    await auth(request(app.getHttpServer()).post(`/products/${id}/stock-in`))
      .send({ quantity: 10, occurredAt: '2026-08-01' })
      .expect(201);

    const afterIn = await auth(
      request(app.getHttpServer()).get(`/products/${id}`),
    );
    expect(afterIn.body.currentStock).toBe(10);

    await auth(request(app.getHttpServer()).post(`/products/${id}/stock-out`))
      .send({ quantity: 3, occurredAt: '2026-08-02' })
      .expect(201);

    const afterOut = await auth(
      request(app.getHttpServer()).get(`/products/${id}`),
    );
    expect(afterOut.body.currentStock).toBe(7);
    expect(afterOut.body.lowStock).toBe(false);

    const history = await auth(
      request(app.getHttpServer()).get(`/products/${id}/transactions`),
    );
    expect(history.body).toHaveLength(2);
    expect(history.body[0].type).toBe('stock_out'); // newest first
    // BR-050 attribution still works, but the recorder's user record never leaks its
    // hash — see main.ts's global ClassSerializerInterceptor.
    expect(history.body[0].recordedBy.name).toBe('E2E User');
    expect(history.body[0].recordedBy.passwordHash).toBeUndefined();
  });

  // Phase 7 (docs/phase-7-plan.md §5/§7): pins the deliberate NON-change — a
  // transaction row is create-only (BR-051), so its response has createdAt and no
  // updatedAt at all, and this test would fail loudly if someone "completed the set"
  // by adding an @UpdateDateColumn to InventoryTransaction.
  it('a transaction response includes createdAt and has no updatedAt', async () => {
    const product = await auth(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;

    await auth(request(app.getHttpServer()).post(`/products/${id}/stock-in`))
      .send({ quantity: 10, occurredAt: '2026-08-01' })
      .expect(201);

    const history = await auth(
      request(app.getHttpServer()).get(`/products/${id}/transactions`),
    );
    expect(history.body).toHaveLength(1);
    expect(typeof history.body[0].createdAt).toBe('string');
    expect(history.body[0].updatedAt).toBeUndefined();
  });

  // Phase 7 §1 "No updated_at bump on child writes bleeding up to parents": recording
  // a transaction against a product must not touch that product's own updatedAt —
  // updatedAt means "this product's own fields were edited," not "some child row
  // referenced it."
  it("recording a stock-in does not change the product's updatedAt", async () => {
    const product = await auth(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;
    const beforeUpdatedAt = product.body.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 50));

    await auth(request(app.getHttpServer()).post(`/products/${id}/stock-in`))
      .send({ quantity: 10, occurredAt: '2026-08-01' })
      .expect(201);

    const after = await auth(
      request(app.getHttpServer()).get(`/products/${id}`),
    );
    expect(after.body.updatedAt).toBe(beforeUpdatedAt);
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
    const res = await auth(
      request(app.getHttpServer()).get('/products/not-a-number'),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s.+\(.+:\d+:\d+\)/); // no stack frame text
  });

  it('rejects a write with no token at all', async () => {
    const res = await request(app.getHttpServer())
      .post('/products')
      .send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    expect(res.status).toBe(401);
  });
});
