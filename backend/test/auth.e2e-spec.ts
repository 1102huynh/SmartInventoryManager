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

// Covers the auth surface itself (docs/phase-3-plan.md §4 "Testing plan") — login
// success/failure and the token boundary. app.e2e-spec.ts covers the *consequence*
// (every existing write now needs a token); this file covers the mechanism.
const PASSWORD = 'correct-horse-battery-staple';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
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
    // This file only exercises /auth/login and /auth/me, never a write — so unlike
    // app.e2e-spec.ts/categories.e2e-spec.ts, it only needs the lowercase value, not
    // a promotion to Owner (docs/phase-5-plan.md §5).
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('Auth Test User', 'staff', 'auth-test@example.com', $1)`,
      [passwordHash],
    );
  });

  it('logs in with correct credentials and returns a token plus the user summary', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      name: 'Auth Test User',
      role: 'staff',
    });
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test@example.com', password: 'not-the-password' });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown email with the exact same 401 message as a wrong password', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test@example.com', password: 'nope' });
    const unknownEmail = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'nope' });
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
  });

  it('rejects a protected route with no token', async () => {
    const res = await request(app.getHttpServer()).post('/products').send({
      name: 'Widget',
      sku: 'W-1',
      unit: 'each',
    });
    expect(res.status).toBe(401);
  });

  it('accepts a protected route with a valid token', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test@example.com', password: PASSWORD });
    // GET /products rather than a write: this test is about the authentication
    // boundary (a valid token gets past JwtAuthGuard), not authorization — a write
    // would conflate it with RolesGuard, since this seeded user is Staff and most
    // writes are now Owner-only (docs/phase-5-plan.md). See roles.e2e-spec.ts for the
    // role-gated behavior itself.
    const res = await request(app.getHttpServer())
      .get('/products')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
  });

  it('rejects a malformed token', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test@example.com', password: PASSWORD });
    const decoded = jwtService.decode<{ sub: number }>(login.body.accessToken);
    // Signed with the app's own JwtService/secret so it's otherwise perfectly valid —
    // isolates "expired" from "malformed"/"wrong secret", which the previous test
    // already covers.
    const expiredToken = jwtService.sign(
      { sub: decoded.sub },
      { expiresIn: '-10s' },
    );
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });

  it('GET /auth/me resolves the caller from the token, without leaking the password hash', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test@example.com', password: PASSWORD });
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('auth-test@example.com');
    expect(res.body.passwordHash).toBeUndefined();
  });
});
