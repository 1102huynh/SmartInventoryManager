// Must run before any other import pulls in ConfigModule — see app.e2e-spec.ts for
// why this has to be the very first thing in the file.
process.env.DB_DATABASE = 'smart_inventory_e2e';

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

// Phase 6 (docs/phase-6-plan.md §5): proves user management end to end over real
// HTTP, against a real database — the one thing users.service.spec.ts (mocked
// repository) can't: that the class-level @Roles(UserRole.Owner), the DTOs, and
// UsersService's write paths actually compose into the behavior the plan describes,
// AND that a deactivated account is actually shut out at both entry points
// (AuthService.validateUser and JwtStrategy.validate) rather than just in isolated
// unit tests of each.
const PASSWORD = 'e2e-test-password';

describe('Users / accounts (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
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
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
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
  });

  function asOwner(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${ownerToken}`);
  }
  function asStaff(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${staffToken}`);
  }

  // -------------------------------------------------------------- BR-074: Owner-only --
  it('rejects Staff with 403 on all six /users routes, including GET /users', async () => {
    const server = app.getHttpServer();

    expect((await asStaff(request(server).get('/users'))).status).toBe(403);
    expect(
      (await asStaff(request(server).get(`/users/${staffId}`))).status,
    ).toBe(403);
    expect(
      (
        await asStaff(request(server).post('/users')).send({
          name: 'New Hire',
          email: 'new@example.com',
          role: 'staff',
          password: 'a-real-password',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asStaff(request(server).patch(`/users/${staffId}`)).send({
          name: 'Renamed',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asStaff(request(server).patch(`/users/${staffId}/status`)).send({
          status: 'inactive',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asStaff(
          request(server).patch(`/users/${staffId}/password`),
        ).send({ newPassword: 'a-new-password' })
      ).status,
    ).toBe(403);
  });

  // -------------------------------------------------------------- create + login round-trip --
  it('Owner creates a user, and that user can immediately log in with the password they were given', async () => {
    const created = await asOwner(request(app.getHttpServer()).post('/users')).send({
      name: 'New Hire',
      email: 'new-hire@example.com',
      role: 'staff',
      password: 'a-real-password',
    });
    expect(created.status).toBe(201);
    expect(created.body.passwordHash).toBeUndefined();

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'new-hire@example.com', password: 'a-real-password' });
    expect(login.status).toBe(200);
  });

  it('duplicate email on create returns 409', async () => {
    const res = await asOwner(request(app.getHttpServer()).post('/users')).send({
      name: 'Clash',
      email: 'staff@example.com',
      role: 'staff',
      password: 'a-real-password',
    });
    expect(res.status).toBe(409);
  });

  // -------------------------------------------------------------- deactivation revokes NOW --
  // The most important test in this file: a deactivated user's existing, unexpired
  // token stops working on their very next request — proving "revoked" rather than
  // "revoked in twelve hours" (docs/phase-6-plan.md §1 "Deactivation is what token
  // revocation turned out to be"). The token is captured BEFORE deactivation.
  it("a deactivated user's existing unexpired token returns 401 on the next request", async () => {
    const tokenCapturedBeforeDeactivation = staffToken;

    const deactivate = await asOwner(
      request(app.getHttpServer()).patch(`/users/${staffId}/status`),
    ).send({ status: 'inactive' });
    expect(deactivate.status).toBe(200);

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${tokenCapturedBeforeDeactivation}`);
    expect(res.status).toBe(401);
  });

  it('a deactivated user cannot log in — distinct message from a wrong password', async () => {
    await asOwner(
      request(app.getHttpServer()).patch(`/users/${staffId}/status`),
    ).send({ status: 'inactive' });

    const correctPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    expect(correctPassword.status).toBe(401);
    expect(correctPassword.body.message).toMatch(/deactivated/i);

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: 'not-the-password' });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.message).not.toMatch(/deactivated/i);
  });

  // Reactivation is the recovery path for an accidental deactivation (in the plan's
  // Definition of Done) and pins BR-077's reversibility — deactivate, confirm login is
  // blocked, reactivate, confirm login works again with the SAME, never-changed
  // password.
  it('a reactivated user can log in again, with the same password as before', async () => {
    await asOwner(
      request(app.getHttpServer()).patch(`/users/${staffId}/status`),
    ).send({ status: 'inactive' });
    const whileInactive = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    expect(whileInactive.status).toBe(401);

    const reactivate = await asOwner(
      request(app.getHttpServer()).patch(`/users/${staffId}/status`),
    ).send({ status: 'active' });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.status).toBe('active');

    const afterReactivation = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    expect(afterReactivation.status).toBe(200);
  });

  // -------------------------------------------------------------- BR-075: last active Owner --
  it('demoting the last active Owner returns 409; succeeds once a second active Owner exists', async () => {
    const demoteAlone = await asOwner(
      request(app.getHttpServer()).patch(`/users/${ownerId}`),
    ).send({ role: 'staff' });
    expect(demoteAlone.status).toBe(409);

    const secondOwner = await asOwner(
      request(app.getHttpServer()).post('/users'),
    ).send({
      name: 'Second Owner',
      email: 'second-owner@example.com',
      role: 'owner',
      password: 'a-real-password',
    });
    expect(secondOwner.status).toBe(201);

    const demoteWithBackup = await asOwner(
      request(app.getHttpServer()).patch(`/users/${ownerId}`),
    ).send({ role: 'staff' });
    expect(demoteWithBackup.status).toBe(200);
  });

  it('deactivating the last active Owner returns 409; succeeds once a second active Owner exists', async () => {
    const deactivateAlone = await asOwner(
      request(app.getHttpServer()).patch(`/users/${ownerId}/status`),
    ).send({ status: 'inactive' });
    expect(deactivateAlone.status).toBe(409);

    const secondOwner = await asOwner(
      request(app.getHttpServer()).post('/users'),
    ).send({
      name: 'Second Owner',
      email: 'second-owner@example.com',
      role: 'owner',
      password: 'a-real-password',
    });
    expect(secondOwner.status).toBe(201);

    const deactivateWithBackup = await asOwner(
      request(app.getHttpServer()).patch(`/users/${ownerId}/status`),
    ).send({ status: 'inactive' });
    expect(deactivateWithBackup.status).toBe(200);
  });

  // -------------------------------------------------------------- passwords --
  it('PATCH /auth/password with the correct current password succeeds; the new password works and the old one does not', async () => {
    const res = await asStaff(
      request(app.getHttpServer()).patch('/auth/password'),
    ).send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(204);

    const withNew = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: 'a-brand-new-password' });
    expect(withNew.status).toBe(200);

    const withOld = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    expect(withOld.status).toBe(401);
  });

  it('PATCH /auth/password with the wrong current password returns 401 and changes nothing', async () => {
    const res = await asStaff(
      request(app.getHttpServer()).patch('/auth/password'),
    ).send({ currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' });
    expect(res.status).toBe(401);

    const withOld = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    expect(withOld.status).toBe(200);
  });

  it('Owner reset via PATCH /users/:id/password: the target logs in with the new password, not the old', async () => {
    const res = await asOwner(
      request(app.getHttpServer()).patch(`/users/${staffId}/password`),
    ).send({ newPassword: 'owner-set-this-password' });
    expect(res.status).toBe(204);

    const withNew = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: 'owner-set-this-password' });
    expect(withNew.status).toBe(200);

    const withOld = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'staff@example.com', password: PASSWORD });
    expect(withOld.status).toBe(401);
  });

  // -------------------------------------------------------------- passwordHash never leaks --
  // Every call asserts its own status FIRST — a `not.toMatch(/passwordHash/)` against
  // an unchecked response passes vacuously against an error body (e.g. an empty
  // `{"message":...}` from a 4xx/5xx contains no `passwordHash` either), which would
  // let this test go green while proving nothing about the success-path response it's
  // actually meant to cover.
  it('no user response body anywhere contains passwordHash, including a nested recordedBy', async () => {
    const list = await asOwner(request(app.getHttpServer()).get('/users'));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash/);

    const one = await asOwner(
      request(app.getHttpServer()).get(`/users/${staffId}`),
    );
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toMatch(/passwordHash/);

    const created = await asOwner(request(app.getHttpServer()).post('/users')).send({
      name: 'No Leak',
      email: 'no-leak@example.com',
      role: 'staff',
      password: 'a-real-password',
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toMatch(/passwordHash/);

    // A transaction's nested `recordedBy` is the other place a User object gets
    // serialized (docs/phase-6-plan.md §5) — record one and check it.
    const product = await asOwner(
      request(app.getHttpServer()).post('/products'),
    ).send({ name: 'Widget', sku: 'W-1', unit: 'each' });
    expect(product.status).toBe(201);
    const stockIn = await asOwner(
      request(app.getHttpServer()).post(`/products/${product.body.id}/stock-in`),
    ).send({ quantity: 10, occurredAt: '2026-08-01' });
    expect(stockIn.status).toBe(201);
    expect(JSON.stringify(stockIn.body)).not.toMatch(/passwordHash/);
  });
});
