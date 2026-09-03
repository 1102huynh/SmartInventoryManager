// Must run before any other import pulls in ConfigModule — see app.e2e-spec.ts.
process.env.DB_DATABASE = 'smart_inventory_e2e';
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
import { CORS_OPTIONS } from '../src/common/cors-options';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

// Phase 12 (docs/phase-12-plan.md §5) — the seventh e2e spec. Proves, over real HTTP
// and a real database, the one thing the phase exists for: a Staff adjustment is a
// request that changes no stock until an Owner approves it, while an Owner adjustment
// is unchanged.
const PASSWORD = 'e2e-test-password';

describe('Adjustment approval (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ownerToken: string;
  let staffToken: string;
  let staffId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableCors(CORS_OPTIONS);
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
      'TRUNCATE TABLE adjustment_requests, inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const rows: Array<{ id: number; role: string }> = await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES
        ('Owner User', 'owner', 'owner@example.com', $1),
        ('Staff User', 'staff', 'staff@example.com', $1)
       RETURNING id, role`,
      [passwordHash],
    );
    staffId = rows.find((r) => r.role === 'staff')!.id;

    ownerToken = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'owner@example.com', password: PASSWORD })
    ).body.accessToken;
    staffToken = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'staff@example.com', password: PASSWORD })
    ).body.accessToken;
  });

  const asOwner = (r: request.Test) =>
    r.set('Authorization', `Bearer ${ownerToken}`);
  const asStaff = (r: request.Test) =>
    r.set('Authorization', `Bearer ${staffToken}`);

  async function makeProductWithStock(qty: number): Promise<number> {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const id = product.body.id;
    await asOwner(request(app.getHttpServer()).post(`/products/${id}/stock-in`))
      .send({ quantity: qty, occurredAt: '2026-08-01' })
      .expect(201);
    return id;
  }

  function stockOf(id: number): Promise<number> {
    return asOwner(request(app.getHttpServer()).get(`/products/${id}`)).then(
      (r) => r.body.currentStock,
    );
  }

  it('Staff adjustment → 202 + a pending request, and stock is unchanged', async () => {
    const id = await makeProductWithStock(10);

    const res = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 8, occurredAt: '2026-08-02', reason: 'Recount' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.requestedBy.name).toBe('Staff User');
    expect(res.body.requestedBy.passwordHash).toBeUndefined();
    // Proven through what a client observes, not by reading the new table.
    expect(await stockOf(id)).toBe(10);
  });

  it('Owner adjustment → 201 + an InventoryTransaction, immediate stock change (unchanged from pre-phase)', async () => {
    const id = await makeProductWithStock(10);

    const res = await asOwner(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 6, occurredAt: '2026-08-02', reason: 'Recount' });

    expect(res.status).toBe(201);
    expect(res.body.quantityDelta).toBe(-4);
    expect(res.body.type).toBe('adjustment');
    expect(await stockOf(id)).toBe(6);
  });

  it('approval changes stock, sets resulting_transaction_id, and attributes the transaction to the requester', async () => {
    const id = await makeProductWithStock(10);
    const req = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 15, occurredAt: '2026-08-02', reason: 'Found more' });

    const approved = await asOwner(
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${req.body.id}/status`,
      ),
    ).send({ status: 'approved' });

    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.resultingTransactionId).toEqual(expect.any(Number));
    expect(await stockOf(id)).toBe(15);

    const txs = await asOwner(
      request(app.getHttpServer()).get(
        `/inventory-transactions?productId=${id}`,
      ),
    );
    const rows = txs.body as Array<{
      type: string;
      quantityDelta: number;
      recordedBy: { id: number };
    }>;
    const adjustmentTx = rows.find((t) => t.type === 'adjustment')!;
    expect(adjustmentTx.quantityDelta).toBe(5);
    expect(adjustmentTx.recordedBy.id).toBe(staffId); // BR-088
  });

  it('rejection requires a reason (400), then the request is terminal (409 on a second resolve)', async () => {
    const id = await makeProductWithStock(10);
    const req = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 99, occurredAt: '2026-08-02', reason: 'Recount' });
    const reqId = req.body.id;

    const noReason = await asOwner(
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${reqId}/status`,
      ),
    ).send({ status: 'rejected' });
    expect(noReason.status).toBe(400);

    const rejected = await asOwner(
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${reqId}/status`,
      ),
    ).send({ status: 'rejected', reason: 'That count is not plausible' });
    expect(rejected.status).toBe(200);

    const again = await asOwner(
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${reqId}/status`,
      ),
    ).send({ status: 'approved' });
    expect(again.status).toBe(409);
    expect(await stockOf(id)).toBe(10);
  });

  it('enforces the actor gate: Staff cannot approve (403); only the requester can withdraw (403 for anyone else, including an Owner); the requester can (200)', async () => {
    const id = await makeProductWithStock(10);
    const mine = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 8, occurredAt: '2026-08-02', reason: 'Mine' });
    const reqId = mine.body.id;
    const patch = () =>
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${reqId}/status`,
      );

    // Staff → approve is Owner-only.
    expect((await asStaff(patch()).send({ status: 'approved' })).status).toBe(
      403,
    );

    // Withdraw is the requester's own act — an Owner (a non-requester) cannot do it,
    // even though the Owner can approve/reject.
    const ownerWithdraw = await asOwner(patch()).send({
      status: 'withdrawn',
      reason: 'not my call',
    });
    expect(ownerWithdraw.status).toBe(403);
    expect(ownerWithdraw.body.message).toMatch(/only the requester/i);

    // A second Staff user (not the requester) also cannot withdraw it.
    const pw = await bcrypt.hash(PASSWORD, 10);
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('Staff Three', 'staff', 'staff3@example.com', $1)`,
      [pw],
    );
    const staff3 = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'staff3@example.com', password: PASSWORD })
    ).body.accessToken;
    const otherStaffWithdraw = await request(app.getHttpServer())
      .patch(`/adjustment-requests/${reqId}/status`)
      .set('Authorization', `Bearer ${staff3}`)
      .send({ status: 'withdrawn', reason: 'nope' });
    expect(otherStaffWithdraw.status).toBe(403);

    // The request is still pending after all those rejected attempts.
    const withdrawn = await asStaff(patch()).send({
      status: 'withdrawn',
      reason: 'Miscounted',
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('withdrawn');
  });

  it('rejects PATCH …/status {status:"pending"} with 400 — a request cannot be moved back', async () => {
    const id = await makeProductWithStock(10);
    const req = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 8, occurredAt: '2026-08-02', reason: 'x' });
    const res = await asOwner(
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${req.body.id}/status`,
      ),
    ).send({ status: 'pending' });
    expect(res.status).toBe(400);
  });

  it('rejects a Staff submission with a future occurredAt (400, BR-052)', async () => {
    const id = await makeProductWithStock(10);
    const res = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    ).send({ newQuantity: 8, occurredAt: '2999-01-01', reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('GET /adjustment-requests is readable by both roles; a Staff caller sees only their own', async () => {
    const id = await makeProductWithStock(1000);
    await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    )
      .send({ newQuantity: 111, occurredAt: '2026-08-02', reason: 'mine 1' })
      .expect(202);
    await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    )
      .send({ newQuantity: 222, occurredAt: '2026-08-02', reason: 'mine 2' })
      .expect(202);

    // A second Staff user submits one of their own.
    const pw = await bcrypt.hash(PASSWORD, 10);
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('Staff Two', 'staff', 'staff2@example.com', $1)`,
      [pw],
    );
    const staff2 = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'staff2@example.com', password: PASSWORD })
    ).body.accessToken;
    await request(app.getHttpServer())
      .post(`/products/${id}/adjustments`)
      .set('Authorization', `Bearer ${staff2}`)
      .send({ newQuantity: 333, occurredAt: '2026-08-02', reason: 'theirs' })
      .expect(202);

    const ownerList = await asOwner(
      request(app.getHttpServer()).get('/adjustment-requests'),
    );
    expect(ownerList.status).toBe(200);
    expect(ownerList.body).toHaveLength(3);

    const staffList = await asStaff(
      request(app.getHttpServer()).get('/adjustment-requests'),
    );
    expect(staffList.status).toBe(200);
    const staffRows = staffList.body as Array<{
      requestedBy: { name: string; passwordHash?: string };
    }>;
    expect(staffRows).toHaveLength(2);
    expect(staffRows.every((r) => r.requestedBy.name === 'Staff User')).toBe(
      true,
    );
    // Nested User is serialized without secrets on the list path too.
    expect(staffRows[0].requestedBy.passwordHash).toBeUndefined();
  });

  it('GET /adjustment-requests is bounded, with X-Result-Truncated present only when more matched', async () => {
    const id = await makeProductWithStock(1000);
    for (let i = 0; i < 3; i++) {
      await asStaff(
        request(app.getHttpServer()).post(`/products/${id}/adjustments`),
      )
        .send({
          newQuantity: 100 + i,
          occurredAt: '2026-08-02',
          reason: `c${i}`,
        })
        .expect(202);
    }

    const capped = await asOwner(
      request(app.getHttpServer()).get('/adjustment-requests?limit=2'),
    );
    expect(capped.status).toBe(200);
    expect(capped.body).toHaveLength(2);
    expect(capped.headers['x-result-truncated']).toBe('true');

    const exact = await asOwner(
      request(app.getHttpServer()).get('/adjustment-requests?limit=3'),
    );
    expect(exact.body).toHaveLength(3);
    expect(exact.headers['x-result-truncated']).toBeUndefined();

    for (const limit of ['0', '501', 'abc']) {
      const bad = await asOwner(
        request(app.getHttpServer()).get(`/adjustment-requests?limit=${limit}`),
      );
      expect(bad.status).toBe(400);
    }
  });

  it('DELETE /products/:id with a pending request → 409 (BR-089), naming the pending request', async () => {
    // A product with no transaction history at all, so BR-004 does not fire first.
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Fresh', sku: 'F-1', unit: 'each' });
    const id = product.body.id;

    await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    )
      .send({
        newQuantity: 5,
        occurredAt: '2026-08-02',
        reason: 'Initial count',
      })
      .expect(202);

    const del = await asOwner(
      request(app.getHttpServer()).delete(`/products/${id}`),
    );
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/pending adjustment request/i);
    expect(del.body.message).not.toMatch(/constraint|foreign key/i);
  });

  it('DELETE /products/:id with only a WITHDRAWN request → 409 (BR-089), not a 500', async () => {
    // The gap the pending-only check missed: adjustment_requests.product_id is
    // RESTRICT for every status, so a resolved request against a history-free product
    // would otherwise hit a raw FK violation.
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Fresh2', sku: 'F-2', unit: 'each' });
    const id = product.body.id;

    const req = await asStaff(
      request(app.getHttpServer()).post(`/products/${id}/adjustments`),
    )
      .send({
        newQuantity: 5,
        occurredAt: '2026-08-02',
        reason: 'Initial count',
      })
      .expect(202);

    await asStaff(
      request(app.getHttpServer()).patch(
        `/adjustment-requests/${req.body.id}/status`,
      ),
    )
      .send({ status: 'withdrawn', reason: 'Miscounted' })
      .expect(200);

    const del = await asOwner(
      request(app.getHttpServer()).delete(`/products/${id}`),
    );
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/adjustment request history/i);
    expect(del.body.message).not.toMatch(/constraint|foreign key/i);
  });
});
