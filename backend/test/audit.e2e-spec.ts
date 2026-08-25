// Must run before any other import pulls in ConfigModule — see app.e2e-spec.ts for
// why this has to be the very first thing in the file.
process.env.DB_DATABASE = 'smart_inventory_e2e';
// Phase 8 (docs/phase-8-plan.md §5/§6): raised so this file's rapid-fire logins never
// trip the production-sized login throttle.
process.env.THROTTLE_LOGIN_LIMIT = '1000';
process.env.THROTTLE_LIMIT = '10000';
// Short enough that the lockout round-trip test below doesn't need a real
// fifteen-minute wait — same value users.e2e-spec.ts uses.
process.env.AUTH_LOCKOUT_MINUTES = '0.05';

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

// Phase 9 (docs/phase-9-plan.md §5): proves the audit log end to end, over real HTTP,
// against a real database — the one thing the unit specs (mocked repository/services)
// can't: that AuthService, UsersService, ProductsService/SuppliersService/
// CategoriesService, and AuditController's Owner-only guard actually compose into the
// behavior the plan describes.
const PASSWORD = 'e2e-test-password';

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ownerToken: string;
  let staffToken: string;
  let ownerId: number;
  let staffId: number;

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
      'TRUNCATE TABLE audit_events, inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const rows = await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash, status) VALUES
        ('Owner User', 'owner', 'owner@example.com', $1, 'active'),
        ('Staff User', 'staff', 'staff@example.com', $1, 'active')
      RETURNING id, email`,
      [passwordHash],
    );
    ownerId = rows.find((r: any) => r.email === 'owner@example.com').id;
    staffId = rows.find((r: any) => r.email === 'staff@example.com').id;

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'owner@example.com', password: PASSWORD });
    ownerToken = ownerLogin.body.accessToken;

    const staffLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    staffToken = staffLogin.body.accessToken;

    // The two logins above are themselves audit events (login_succeeded) — clear the
    // table again so each test starts from a genuinely empty log, the way a fresh
    // `npm run seed` database would (docs/phase-9-plan.md §2 "the audit log is
    // legitimately empty afterward").
    await dataSource.query('TRUNCATE TABLE audit_events RESTART IDENTITY CASCADE');
  });

  function asOwner(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${ownerToken}`);
  }
  function asStaff(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${staffToken}`);
  }

  // -------------------------------------------------------------- BR-084: Owner-only --
  it('rejects Staff with 403 and allows Owner with 200 on GET /audit-events', async () => {
    const staffAttempt = await asStaff(
      request(app.getHttpServer()).get('/audit-events'),
    );
    expect(staffAttempt.status).toBe(403);

    const ownerAttempt = await asOwner(
      request(app.getHttpServer()).get('/audit-events'),
    );
    expect(ownerAttempt.status).toBe(200);
    expect(Array.isArray(ownerAttempt.body)).toBe(true);
  });

  // -------------------------------------------------------------- the lockout round trip --
  // The headline user story of the phase (docs/phase-9-plan.md §5): the Phase 8
  // `locked` badge finally leads somewhere. Asserted as a whole, not in pieces.
  it('records five login_failed rows and exactly one account_locked, all against the right subject with no actor', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'staff@example.com', password: 'wrong-password' });
    }

    const res = await asOwner(
      request(app.getHttpServer()).get(
        `/audit-events?subjectUserId=${staffId}`,
      ),
    );
    expect(res.status).toBe(200);
    const events: any[] = res.body;

    const failed = events.filter((e) => e.eventType === 'login_failed');
    const locked = events.filter((e) => e.eventType === 'account_locked');
    expect(failed).toHaveLength(5);
    expect(locked).toHaveLength(1);
    for (const e of [...failed, ...locked]) {
      expect(e.subject?.id ?? e.subjectUserId).toBe(staffId);
      expect(e.actor).toBeNull();
      expect(e.actorUserId ?? null).toBeNull();
    }

    // The lock is a CONSEQUENCE of the fifth failure, not a peer of it — reading
    // newest-first (id DESC, which is also how the query is ordered and how the
    // screen renders), it must sort ABOVE every login_failed row, including the one
    // that triggered it. Getting AuthService's record-then-lock order backwards
    // would make an Owner reading this screen see "Locked" appear to precede the
    // very attempt that caused it.
    const maxFailedId = Math.max(...failed.map((e) => e.id));
    expect(locked[0].id).toBeGreaterThan(maxFailedId);
    expect(events[0].eventType).toBe('account_locked'); // events[] is already newest-first
  });

  // -------------------------------------------------------------- administrative events --
  it('an Owner changing a user role records user_updated with the Owner as actor and the target as subject', async () => {
    const res = await asOwner(
      request(app.getHttpServer()).patch(`/users/${staffId}`),
    ).send({ role: 'owner' });
    expect(res.status).toBe(200);

    const log = await asOwner(
      request(app.getHttpServer()).get(
        `/audit-events?eventType=user_updated&subjectUserId=${staffId}`,
      ),
    );
    expect(log.status).toBe(200);
    expect(log.body).toHaveLength(1);
    expect(log.body[0].actor.id).toBe(ownerId);
    expect(log.body[0].subject.id).toBe(staffId);
    expect(log.body[0].summary).toMatch(/role/i);
  });

  // Item 1 from the code review: neither delete path (products or categories) had
  // any e2e coverage, and the best-effort try/catch in AuditService.record makes
  // that hole silent — a stray constraint or a reordered write would swallow the
  // failure and the DELETE would still return 204. §1 "entity_id is deliberately
  // NOT a foreign key": this proves the audit row genuinely survives the deletion
  // it describes, not merely that the service *tries* to record one.
  it('an Owner deleting a product with no history records product_deleted, and the row survives even though the product itself is gone', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const productId = product.body.id;
    await dataSource.query('TRUNCATE TABLE audit_events RESTART IDENTITY CASCADE');

    const del = await asOwner(
      request(app.getHttpServer()).delete(`/products/${productId}`),
    );
    expect(del.status).toBe(204);

    // The product itself is genuinely gone...
    const getAfter = await asOwner(
      request(app.getHttpServer()).get(`/products/${productId}`),
    );
    expect(getAfter.status).toBe(404);

    // ...but the audit row naming it survives, with no FK to have blocked either.
    const log = await asOwner(
      request(app.getHttpServer()).get('/audit-events?eventType=product_deleted'),
    );
    expect(log.status).toBe(200);
    expect(log.body).toHaveLength(1);
    expect(log.body[0].actor.id).toBe(ownerId);
    expect(log.body[0].entityId).toBe(productId);
    expect(log.body[0].summary).toMatch(/W-1/);
  });

  // -------------------------------------------------------------- BR-083: the non-change test --
  // The direct analogue of Phase 7's "a transaction response has no updatedAt" and
  // Phase 8's "a locked account's existing token still works" — this would fail
  // loudly if someone "completed the set" by adding audit calls to
  // InventoryService, which is exactly the well-intentioned change §1 exists to
  // prevent.
  it('records nothing for stock-in or stock-out — inventory_transactions stays the only record of stock movement', async () => {
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    const productId = product.body.id;

    // The product-creation event itself is administrative, not a stock event — clear
    // the log so this test only has to reason about stock-in/out afterward.
    await dataSource.query('TRUNCATE TABLE audit_events RESTART IDENTITY CASCADE');

    const stockIn = await asOwner(
      request(app.getHttpServer()).post(`/products/${productId}/stock-in`),
    ).send({ quantity: 10, occurredAt: '2026-08-01' });
    expect(stockIn.status).toBe(201);

    const stockOut = await asOwner(
      request(app.getHttpServer()).post(`/products/${productId}/stock-out`),
    ).send({ quantity: 3, occurredAt: '2026-08-02' });
    expect(stockOut.status).toBe(201);

    const log = await asOwner(request(app.getHttpServer()).get('/audit-events'));
    expect(log.status).toBe(200);
    expect(log.body).toEqual([]);
  });

  // -------------------------------------------------------------- serialization safety --
  it('the joined actor/subject on an audit event carry no passwordHash, failedLoginAttempts, or lockedUntil', async () => {
    await asOwner(request(app.getHttpServer()).patch(`/users/${staffId}`)).send({
      name: 'Renamed',
    });
    const res = await asOwner(request(app.getHttpServer()).get('/audit-events'));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    expect(JSON.stringify(res.body)).not.toMatch(/failedLoginAttempts/);
    expect(JSON.stringify(res.body)).not.toMatch(/lockedUntil/);
  });

  // -------------------------------------------------------------- the cap --
  it('respects an explicit limit, and rejects a limit over 500 with 400', async () => {
    for (let i = 0; i < 3; i++) {
      await asOwner(request(app.getHttpServer()).post('/categories')).send({
        name: `Category ${i}`,
      });
    }
    const capped = await asOwner(
      request(app.getHttpServer()).get('/audit-events?limit=2'),
    );
    expect(capped.status).toBe(200);
    expect(capped.body).toHaveLength(2);

    const tooLarge = await asOwner(
      request(app.getHttpServer()).get('/audit-events?limit=100000'),
    );
    expect(tooLarge.status).toBe(400);
  });

  it('rejects a non-positive days with 400 instead of silently returning an empty list', async () => {
    const res = await asOwner(
      request(app.getHttpServer()).get('/audit-events?days=-5'),
    );
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------- scope fork A: client IP --
  it('a login_failed row carries a non-null actorIp; an administrative event carries none', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: 'wrong-password' });
    const authLog = await asOwner(
      request(app.getHttpServer()).get('/audit-events?eventType=login_failed'),
    );
    expect(authLog.body).toHaveLength(1);
    expect(authLog.body[0].actorIp).not.toBeNull();

    await asOwner(request(app.getHttpServer()).post('/categories')).send({
      name: 'Beverages',
    });
    const adminLog = await asOwner(
      request(app.getHttpServer()).get(
        '/audit-events?eventType=category_created',
      ),
    );
    expect(adminLog.body).toHaveLength(1);
    expect(adminLog.body[0].actorIp).toBeNull();
  });
});
