process.env.DB_DATABASE = 'smart_inventory_e2e';
// Phase 8 (docs/phase-8-plan.md §5/§6): a generous login-throttle limit for the whole
// file — this is the file that deliberately fails logins on purpose (the lockout
// tests below), and none of that should trip the throttle meant for a much larger,
// genuinely-abusive volume. The 'rate limiting on POST /auth/login' describe block
// further down lowers this value, live, for its own isolated app instance only — see
// its comment for why a per-request env read (not a module-load-time constant) is
// what makes that possible.
process.env.THROTTLE_LOGIN_LIMIT = '1000';
// The global default limit too — set explicitly, not left to whatever a
// previously-run spec file happened to leave in process.env (a real global, shared
// across every file in this worker, not reset by Jest's per-file module registry).
// Every file in this suite sets what IT needs rather than relying on another file's
// leftovers, and this one is no exception.
process.env.THROTTLE_LIMIT = '10000';
// A short lockout window (three seconds, not fifteen minutes) so the auto-expiry
// round trip below is provable in a test rather than asserted by reading the column.
// Safe for every OTHER test in this file too: none of them fail the same account
// anywhere near the five-attempt threshold, so a short window changes nothing for
// them — see AUTH_MAX_FAILED_ATTEMPTS' default, unchanged.
process.env.AUTH_LOCKOUT_MINUTES = '0.05';

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

  let staffId: number;

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE inventory_transactions, products, suppliers, users, categories RESTART IDENTITY CASCADE',
    );
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const [staff] = await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('Auth Test User', 'staff', 'auth-test@example.com', $1) RETURNING id`,
      [passwordHash],
    );
    staffId = staff.id;
    // Phase 8 (docs/phase-8-plan.md §5 "An Owner's password reset clears a lock"):
    // an Owner account, seeded alongside the original Staff one, purely for the
    // lock-clearing test below — everything else in this file still only needs the
    // one Staff user it always has.
    await dataSource.query(
      `INSERT INTO users (name, role, email, password_hash) VALUES ('Auth Test Owner', 'owner', 'auth-test-owner@example.com', $1)`,
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

  // Phase 8 (docs/phase-8-plan.md §1 "the email-casing bug in the function this
  // phase edits"): a bug found while reading AuthService.validateUser for this
  // phase, not introduced by it — fixed as part of the same change.
  it("logs in successfully regardless of the email's casing", async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'Auth-Test@Example.com', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------- Phase 8: account lockout --
  describe('account lockout', () => {
    async function failLoginNTimes(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        const res = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'auth-test@example.com', password: 'wrong-password' });
        expect(res.status).toBe(401);
      }
    }

    // The full round trip, and the one test in this file that proves the lock
    // actually EXPIRES rather than merely being set — a fifteen-minute production
    // default would be untestable; AUTH_LOCKOUT_MINUTES=0.05 (three seconds, set at
    // the top of this file) is what makes this provable at all.
    it('locks the account after five consecutive failures, and the lock expires on its own', async () => {
      await failLoginNTimes(5);

      // The 6th attempt, even with the CORRECT password, is now locked — not the
      // generic 401 a 6th WRONG guess would also produce.
      const whileLocked = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'auth-test@example.com', password: PASSWORD });
      expect(whileLocked.status).toBe(401);
      expect(whileLocked.body.message).toMatch(/Too many failed attempts/);

      await new Promise((resolve) => setTimeout(resolve, 3500));

      const afterExpiry = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'auth-test@example.com', password: PASSWORD });
      expect(afterExpiry.status).toBe(200);
    }, 15000); // generous timeout: this test deliberately waits out the lockout window

    // §1 "A lock must not become a denial-of-service weapon": a failed attempt
    // against an ALREADY-locked account must not push the lock further out — proven
    // here by locking, failing again, then waiting only the ORIGINAL window and
    // succeeding. If a failure during the lock re-extended it, this would still be
    // locked at that point and the final login would 401, not 200.
    it('a failed attempt during an active lock does not extend it', async () => {
      await failLoginNTimes(5);
      await failLoginNTimes(1); // one more failure, while already locked

      await new Promise((resolve) => setTimeout(resolve, 3500));

      const afterExpiry = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'auth-test@example.com', password: PASSWORD });
      expect(afterExpiry.status).toBe(200);
    }, 15000);

    // A different bug from the one above, easy to conflate with it: this proves an
    // EXPIRED lock gives the account a genuinely fresh count, not a stale one
    // sitting AT the threshold and one guess from re-locking. Without the reset,
    // failing once every lockout window — a much slower, much stealthier attack
    // than "one guess a minute" — would keep the account locked indefinitely, which
    // is exactly the permanent-outage outcome BR-080 exists to rule out. Four more
    // failures after the window clears must stay well under the threshold and never
    // re-lock the account.
    it('failures after an expired lock start a fresh count, and do not immediately re-lock the account', async () => {
      await failLoginNTimes(5); // locks the account
      await new Promise((resolve) => setTimeout(resolve, 3500)); // wait out the lock

      await failLoginNTimes(4); // four MORE failures — one short of a fresh lock

      const stillUnlocked = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'auth-test@example.com', password: PASSWORD });
      expect(stillUnlocked.status).toBe(200);
    }, 15000);

    it("an Owner's password reset clears a lock, and the new password logs in immediately", async () => {
      await failLoginNTimes(5);

      const ownerLogin = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'auth-test-owner@example.com', password: PASSWORD });
      expect(ownerLogin.status).toBe(200);

      const reset = await request(app.getHttpServer())
        .patch(`/users/${staffId}/password`)
        .set('Authorization', `Bearer ${ownerLogin.body.accessToken}`)
        .send({ newPassword: 'owner-set-this-password' });
      expect(reset.status).toBe(204);

      // Immediately — no waiting out the lock — because the reset cleared it.
      const afterReset = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'auth-test@example.com',
          password: 'owner-set-this-password',
        });
      expect(afterReset.status).toBe(200);
    });

    // BR-081, the deliberate difference from BR-077 (deactivation): a lock blocks
    // OBTAINING a new token, it does not revoke an EXISTING one. This is the
    // "completed the set" pin — it would fail loudly if a future change added a
    // lock check to JwtStrategy.validate the way status already has one.
    it("a locked account's existing, already-issued token still works", async () => {
      const tokenCapturedBeforeLock = (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'auth-test@example.com', password: PASSWORD })
      ).body.accessToken;

      await failLoginNTimes(5);

      const me = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${tokenCapturedBeforeLock}`);
      expect(me.status).toBe(200);
    });
  });

  // ---------------------------------------------------------- Phase 8: rate limiting --
  // A separate, isolated NestJS application instance PER TEST (and therefore a
  // separate, EMPTY in-memory throttle counter for POST /auth/login each time) so
  // each test's low limit is exercised on a genuinely clean slate — not just
  // independent of the tests above, but independent of each OTHER too. Without a
  // fresh app per test, a test later in this block would inherit however many hits
  // an earlier one already logged against the same in-process counter, and "N wrong
  // guesses reach the limit" would describe leftover state, not what that test
  // actually did. THROTTLE_LOGIN_LIMIT is read live, per request (see
  // AuthController's loginThrottleLimit()), which is what lets this block lower it
  // at all, on an app it creates itself.
  describe('rate limiting on POST /auth/login', () => {
    let throttleApp: INestApplication;
    const ORIGINAL_LIMIT = process.env.THROTTLE_LOGIN_LIMIT;

    // beforeEach/afterEach, not beforeAll/afterAll — a fresh app (and therefore a
    // fresh, empty in-memory throttle counter) for EACH test in this block, not just
    // once for the whole block. Without this, the second test's "three wrong
    // guesses reach the limit" would really be "the bucket left over from the first
    // test's five requests was already past the limit" — true by accident, and the
    // comment would be describing a scenario that isn't what's actually running.
    beforeEach(async () => {
      process.env.THROTTLE_LOGIN_LIMIT = '3';
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      throttleApp = moduleRef.createNestApplication();
      throttleApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      throttleApp.useGlobalFilters(new AllExceptionsFilter());
      throttleApp.useGlobalInterceptors(
        new ClassSerializerInterceptor(throttleApp.get(Reflector)),
      );
      await throttleApp.init();
    });

    afterEach(async () => {
      await throttleApp.close();
      process.env.THROTTLE_LOGIN_LIMIT = ORIGINAL_LIMIT;
    });

    // The outer describe's beforeEach still runs for tests nested in here (Jest
    // composes ancestor hooks), so 'auth-test@example.com' already exists — this
    // block only needed its own app instance, not its own seeding.

    it('returns 429 with the documented error shape and a Retry-After header once the limit is exceeded', async () => {
      let last: request.Response | undefined;
      for (let i = 0; i < 5; i++) {
        last = await request(throttleApp.getHttpServer())
          .post('/auth/login')
          .send({ email: 'auth-test@example.com', password: 'wrong-password' });
      }
      expect(last!.status).toBe(429);
      expect(last!.body).toEqual({
        statusCode: 429,
        message: 'Too many requests. Please slow down and try again shortly.',
        error: 'Too Many Requests',
      });
      expect(last!.headers['retry-after']).toBeDefined();
    });

    // Pins the guard ordering (docs/phase-8-plan.md §1 "The throttler guard runs
    // first"): a throttler registered after JwtAuthGuard, or running as route
    // middleware too late, would let a correctly-guessed password through to a 200
    // even over the limit. Three wrong guesses reach the limit; the fourth request —
    // this one, with the CORRECT password — must still be rejected before
    // AuthService.validateUser (and therefore bcrypt) ever runs.
    it('an over-limit request with the correct password still returns 429, not 200', async () => {
      for (let i = 0; i < 3; i++) {
        await request(throttleApp.getHttpServer())
          .post('/auth/login')
          .send({ email: 'auth-test@example.com', password: 'wrong-password' });
      }
      const res = await request(throttleApp.getHttpServer())
        .post('/auth/login')
        .send({ email: 'auth-test@example.com', password: PASSWORD });
      expect(res.status).toBe(429);
    });
  });
});
