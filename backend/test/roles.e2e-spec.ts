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
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

// Phase 5 (docs/phase-5-plan.md §5): proves the Owner/Staff split end to end, over
// real HTTP, against a real database — the one thing roles.guard.spec.ts (mocked
// Reflector/ExecutionContext) and jwt.strategy.spec.ts (mocked UsersService) can't:
// that the two guards, the strategy's DB lookup, and the ten @Roles(UserRole.Owner)
// routes actually compose into the behavior the plan describes.
const PASSWORD = 'e2e-test-password';

describe('Roles / authorization (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let ownerToken: string;
  let staffToken: string;

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
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE adjustment_requests, inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES
        ('Owner User', 'owner', 'owner@example.com', $1),
        ('Staff User', 'staff', 'staff@example.com', $1)`,
      [passwordHash],
    );

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'owner@example.com', password: PASSWORD });
    ownerToken = ownerLogin.body.accessToken;

    const staffLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    staffToken = staffLogin.body.accessToken;
  });

  function asOwner(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${ownerToken}`);
  }
  function asStaff(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${staffToken}`);
  }

  it('rejects Staff creating a product with 403, and allows Owner with 201', async () => {
    const staffAttempt = await asStaff(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    expect(ownerAttempt.status).toBe(201);
  });

  it('rejects Staff editing a product with 403, and allows Owner with 200', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;

    // UpdateProductDto requires name+unit even though this is a PATCH (see its own
    // comment on why it isn't PartialType) — send both so a real 200 from Owner
    // can't be confused with a 400 from an incomplete body.
    const staffAttempt = await asStaff(
      request(app.getHttpServer()).patch(`/products/${id}`),
    ).send({ name: 'Widget v2', unit: 'each' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).patch(`/products/${id}`),
    ).send({ name: 'Widget v2', unit: 'each' });
    expect(ownerAttempt.status).toBe(200);
  });

  it('rejects Staff setting a product status with 403, and allows Owner with 200', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;

    const staffAttempt = await asStaff(
      request(app.getHttpServer()).patch(`/products/${id}/status`),
    ).send({ status: 'inactive' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).patch(`/products/${id}/status`),
    ).send({ status: 'inactive' });
    expect(ownerAttempt.status).toBe(200);
  });

  it('rejects Staff deleting a product with 403, and allows Owner with 204', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;

    const staffAttempt = await asStaff(
      request(app.getHttpServer()).delete(`/products/${id}`),
    );
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).delete(`/products/${id}`),
    );
    expect(ownerAttempt.status).toBe(204);
  });

  it('rejects Staff creating a supplier with 403, and allows Owner with 201', async () => {
    const staffAttempt = await asStaff(
      request(app.getHttpServer()).post('/suppliers'),
    ).send({ name: 'Acme Supplies' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).post('/suppliers'),
    ).send({ name: 'Acme Supplies' });
    expect(ownerAttempt.status).toBe(201);
  });

  it('rejects Staff editing a supplier with 403, and allows Owner with 200', async () => {
    const supplier = await asOwner(
      request(app.getHttpServer()).post('/suppliers'),
    ).send({ name: 'Acme Supplies' });
    const id = supplier.body.id;

    const staffAttempt = await asStaff(
      request(app.getHttpServer()).patch(`/suppliers/${id}`),
    ).send({ name: 'Acme Supplies Inc.' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).patch(`/suppliers/${id}`),
    ).send({ name: 'Acme Supplies Inc.' });
    expect(ownerAttempt.status).toBe(200);
  });

  it('rejects Staff setting a supplier status with 403, and allows Owner with 200', async () => {
    const supplier = await asOwner(
      request(app.getHttpServer()).post('/suppliers'),
    ).send({ name: 'Acme Supplies' });
    const id = supplier.body.id;

    const staffAttempt = await asStaff(
      request(app.getHttpServer()).patch(`/suppliers/${id}/status`),
    ).send({ status: 'inactive' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).patch(`/suppliers/${id}/status`),
    ).send({ status: 'inactive' });
    expect(ownerAttempt.status).toBe(200);
  });

  it('rejects Staff creating a category with 403, and allows Owner with 201', async () => {
    const staffAttempt = await asStaff(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    expect(ownerAttempt.status).toBe(201);
  });

  it('rejects Staff renaming a category with 403, and allows Owner with 200', async () => {
    const category = await asOwner(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    const id = category.body.id;

    const staffAttempt = await asStaff(
      request(app.getHttpServer()).patch(`/categories/${id}`),
    ).send({ name: 'Drinks' });
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).patch(`/categories/${id}`),
    ).send({ name: 'Drinks' });
    expect(ownerAttempt.status).toBe(200);
  });

  it('rejects Staff deleting a category with 403, and allows Owner with 204', async () => {
    const category = await asOwner(
      request(app.getHttpServer()).post('/categories'),
    ).send({ name: 'Beverages' });
    const id = category.body.id;

    const staffAttempt = await asStaff(
      request(app.getHttpServer()).delete(`/categories/${id}`),
    );
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).delete(`/categories/${id}`),
    );
    expect(ownerAttempt.status).toBe(204);
  });

  // The most important test in this file: it proves the phase didn't over-lock the
  // system and break the exact workflow the product exists for. A regression here
  // would be worse than a missing 403 — see docs/phase-5-plan.md §5.
  it('allows Staff to record a stock-out', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;
    await asOwner(
      request(app.getHttpServer()).post(`/products/${id}/stock-in`),
    ).send({ quantity: 10, occurredAt: '2026-08-01' });

    const res = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/stock-out`),
    ).send({ quantity: 3, occurredAt: '2026-08-02' });
    expect(res.status).toBe(201);
  });

  // Phase 12 (docs/phase-12-plan.md §1) AMENDS BR-072. Either role may still
  // *initiate* an adjustment on the same route, but a Staff-initiated adjustment no
  // longer becomes a transaction directly: it is a pending request (202 +
  // AdjustmentRequest, no stock change) that an Owner approves or rejects. An
  // Owner-initiated adjustment is still recorded immediately (201 + InventoryTransaction).
  // This test was rewritten to state that new rule rather than deleted — a regression
  // that made the route Owner-only, or that let a Staff adjustment change stock
  // without approval, would both be caught here.
  it('accepts a Staff adjustment as a pending request (202), and records an Owner adjustment immediately (201)', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;
    await asOwner(
      request(app.getHttpServer()).post(`/products/${id}/stock-in`),
    ).send({ quantity: 10, occurredAt: '2026-08-01' });

    const staffRes = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 8, occurredAt: '2026-08-02', reason: 'Recount' });
    expect(staffRes.status).toBe(202);
    expect(staffRes.body.status).toBe('pending');
    // Stock is unchanged — the request has not been approved.
    const afterStaff = await asStaff(
      request(app.getHttpServer()).get(`/products/${id}`),
    );
    expect(afterStaff.body.currentStock).toBe(10);

    const ownerRes = await asOwner(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({
      newQuantity: 6,
      occurredAt: '2026-08-03',
      reason: 'Owner recount',
    });
    expect(ownerRes.status).toBe(201);
    expect(ownerRes.body.quantityDelta).toBe(-4);
  });

  it('allows Staff to read products and the dashboard summary', async () => {
    const products = await asStaff(
      request(app.getHttpServer()).get('/products'),
    );
    expect(products.status).toBe(200);

    const dashboard = await asStaff(
      request(app.getHttpServer()).get('/dashboard/summary'),
    );
    expect(dashboard.status).toBe(200);
  });

  it('a 403 response body carries the Owner-role message, not a generic "Forbidden resource"', async () => {
    const res = await asStaff(
      request(app.getHttpServer()).post('/products'),
    ).send({
      name: 'Widget',
      sku: 'W-1',
      unit: 'each',
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This action requires the Owner role.');
  });

  it('rejects a valid, unexpired token whose user row has been deleted, with 401', async () => {
    const staffRow = await dataSource.query(
      `SELECT id FROM users WHERE email = 'staff@example.com'`,
    );
    const staffId: number = staffRow[0].id;
    const orphanToken = jwtService.sign({ sub: staffId });
    // Phase 9 (docs/phase-9-plan.md §1): this beforeEach's staff login already wrote
    // a login_succeeded audit_events row with a RESTRICT foreign key to this user
    // (BR-076 — the same guarantee inventory_transactions.recorded_by_user_id
    // relies on) — a real app path never deletes a user row at all, but this test
    // deliberately does, via raw SQL, purely to construct the orphaned-token
    // scenario below, so the audit row has to be cleared first to allow it.
    await dataSource.query(
      'DELETE FROM audit_events WHERE actor_user_id = $1 OR subject_user_id = $1',
      [staffId],
    );
    await dataSource.query('DELETE FROM users WHERE id = $1', [staffId]);

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${orphanToken}`);
    expect(res.status).toBe(401);
  });
});
