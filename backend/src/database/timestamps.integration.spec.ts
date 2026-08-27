import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditEvent } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { UserRole } from '../common/enums/user-role.enum';
import { AppConfig } from '../config/configuration';
import { createTestDataSource } from './test-data-source';
import { Category } from '../categories/category.entity';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';

// Phase 10 (docs/phase-10-plan.md §5). The honest shape of this phase's testing: the
// rest of this project's suite cannot distinguish before this phase from after it —
// every other test runs on one machine where Node and Postgres share a zone, which is
// exactly the condition under which the old plain-TIMESTAMP schema was already
// correct. This file is the one place that forces the two apart on purpose, because
// that's the only way to prove what this phase actually bought: for a naive
// `created_at`/`updated_at` column, the digits are written in Postgres's session zone
// and read back in Node's, and the two cancel out only while they happen to be equal
// (§1). `locked_until` is the schema's one exception to that write-side mechanism — see
// the third test's own comment below, not this paragraph, for why.
//
// PINNED_ZONE below is applied to *Postgres's session*, not Node's — and that choice
// is load-bearing, not arbitrary. `process.env.TZ = 'America/Los_Angeles'` at the top
// of the file (matching auth.e2e-spec.ts's pattern for THROTTLE_LOGIN_LIMIT and
// AUTH_LOCKOUT_MINUTES) was tried first, and doesn't work on this platform: Jest's own
// bootstrap already touches `Date` before a test file's top-level statements run,
// caching the process's real OS zone into V8 before the assignment can take effect —
// a `getTimezoneOffset()` check placed right after the assignment still reports the
// original zone. A first version of this file's headline test used that broken
// mechanism, silently proved nothing (Node's zone never actually moved, so nothing
// was being exercised), and still turned green — a smaller instance of the exact
// unchecked-ambient-agreement defect this phase exists to remove. The offset guard in
// beforeAll below exists specifically to fail loudly if that ever happens again.
//
// A second version pinned Postgres's session zone but still compared "the ORM-written
// row" against "the DEFAULT now()-written row," expecting a naive column to make them
// disagree. It doesn't, for `@CreateDateColumn`/`@UpdateDateColumn`: logging the actual
// generated SQL showed TypeORM never sends a computed value for these columns when the
// entity carries none of its own (the only way this app ever uses them) — it emits the
// literal `DEFAULT` (insert) / `CURRENT_TIMESTAMP` (update), which Postgres evaluates
// itself, in its *session* zone, indistinguishable from a raw `DEFAULT now()`. Both
// writers end up depending on the same session zone, so they always agree with *each
// other*, even on a reverted schema — comparing them proves nothing. The actual
// corruption is on the *read* side: a naive column's digits carry no zone marker, so
// reading them back reinterprets whatever was stored as local time in the *reading*
// process's own zone (Node's real, unmodified zone), which is wrong whenever it differs
// from the zone the digits were written in. So each test below compares a
// round-tripped value against the real wall-clock instant the write actually happened
// at — not against a second writer.
const PINNED_ZONE = 'America/Los_Angeles';

// The first two tests below are *verified* regression guards: each pins a value in
// place under a Postgres session deliberately zoned away from Node's real zone, then
// asserts the value read back still equals the instant it was actually written at.
// Both were confirmed by deliberately reverting `categories.created_at` to
// `type: 'timestamp'` and watching them fail by exactly the offset between the two
// zones, then pass again once reverted back.
//
// The third test (`locked_until`) pins the *functional* claim — the window really is
// fifteen minutes — that motivates converting a column Phase 8 called non-audit (§1),
// but is NOT also a regression guard, and this took two wrong guesses to settle
// (docs/phase-10-plan.md §1's `locked_until` bullet and §5 have the full history).
// `locked_until` is an application-computed value (`registerFailedLogin`) with no
// database default to defer to, so — unlike the `@CreateDateColumn`/`@UpdateDateColumn`
// columns above — it's sent to `pg` as an actual Date parameter and keeps NODE's own
// zone, not the session's, on the way into a naive column. Its write zone and read zone
// were therefore always both Node's, so it never shared the audit columns' exposure to
// begin with. Confirmed by reverting `users.locked_until` to `type: 'timestamp'` under
// this same pinned-session harness: the round trip stayed correct, where the two tests
// above fail reliably under the same kind of revert.
describe('Timestamps (integration)', () => {
  let dataSource: DataSource;
  let usersService: UsersService;

  // Real threshold/window values, not a bare `{}` — a test that gets these wrong
  // should fail loudly instead of silently comparing against `undefined`. Mirrors
  // users.service.spec.ts's configService fixture; cast because this is a direct
  // `new UsersService(...)` rather than a Nest testing module, so nothing else
  // type-checks the shape for us.
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'security.maxFailedLoginAttempts') return 5;
      if (key === 'security.lockoutMinutes') return 15;
      throw new Error(`unexpected config key in test: ${key}`);
    }),
  } as unknown as ConfigService<AppConfig, true>;

  beforeAll(async () => {
    dataSource = createTestDataSource({
      extra: { options: `-c timezone=${PINNED_ZONE}` },
    });
    await dataSource.initialize();
    usersService = new UsersService(
      dataSource.getRepository(User),
      configService,
      new AuditService(dataSource.getRepository(AuditEvent)),
    );

    // This whole file discriminates only if Postgres's (pinned) session zone and
    // Node's (real, unmodified) zone actually disagree — the header comment names an
    // offset, not a promise, and nothing enforces it short of an explicit check.
    // Compare offsets, not zone names (two names can share one offset, e.g.
    // Asia/Bangkok and Asia/Ho_Chi_Minh, both UTC+7 with no DST): if this suite is
    // ever run against a host whose real zone happens to coincide with PINNED_ZONE,
    // the tests below would pass without proving anything — silently reintroducing
    // exactly the kind of unchecked-ambient-agreement defect this phase exists to
    // remove. Fail loudly instead.
    const [{ pgOffsetSeconds }] = await dataSource.query(
      `SELECT EXTRACT(timezone FROM now())::int AS "pgOffsetSeconds"`,
    );
    const nodeOffsetSeconds = -new Date().getTimezoneOffset() * 60;
    if (Number(pgOffsetSeconds) === nodeOffsetSeconds) {
      throw new Error(
        `This suite proves nothing unless Postgres's session zone and Node's real ` +
          `zone disagree, but both are currently UTC${nodeOffsetSeconds >= 0 ? '+' : ''}${nodeOffsetSeconds / 3600}. ` +
          `Change PINNED_ZONE (top of this file) to a zone with a different offset ` +
          `from this host's real zone.`,
      );
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE audit_events, inventory_transactions, users, categories, products, suppliers RESTART IDENTITY CASCADE',
    );
  });

  // A generous tolerance for the test's own execution time, and nothing more — a
  // value corrupted by the zone mismatch this file forces would miss by hours (the
  // gap between Node's real zone and PINNED_ZONE), not seconds.
  const TOLERANCE_MS = 2_000;

  it('a TypeORM-written row round-trips to the instant it was actually written at', async () => {
    const before = Date.now();
    const saved = await dataSource
      .getRepository(Category)
      .save({ name: 'orm-cat' });
    const after = Date.now();

    // The value returned by save() itself comes back via the INSERT's RETURNING
    // clause — already a full write-then-read round trip, not merely the JS Date
    // TypeORM sent. A second, independent read confirms it's what's actually
    // persisted, not an artifact of that one code path.
    const reread = await dataSource
      .getRepository(Category)
      .findOne({ where: { id: saved.id } });

    expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(
      before - TOLERANCE_MS,
    );
    expect(saved.createdAt.getTime()).toBeLessThanOrEqual(after + TOLERANCE_MS);
    expect(reread).not.toBeNull();
    expect(reread!.createdAt.getTime()).toBeGreaterThanOrEqual(
      before - TOLERANCE_MS,
    );
    expect(reread!.createdAt.getTime()).toBeLessThanOrEqual(
      after + TOLERANCE_MS,
    );
  });

  it('a DEFAULT now()-written row round-trips to the instant it was actually written at', async () => {
    const before = Date.now();
    await dataSource.query(
      `INSERT INTO categories (name) VALUES ('raw-cat')`,
    );
    const after = Date.now();
    const [rawRow] = await dataSource.query(
      `SELECT created_at FROM categories WHERE name = 'raw-cat'`,
    );

    const rawInstant = new Date(rawRow.created_at as string).getTime();

    expect(rawInstant).toBeGreaterThanOrEqual(before - TOLERANCE_MS);
    expect(rawInstant).toBeLessThanOrEqual(after + TOLERANCE_MS);
  });

  // locked_until survives a round trip as an instant — pins §1's argument for
  // converting a column Phase 8 explicitly called non-audit ("operational state, not
  // a record of when something happened"): `isLocked` compares two instants
  // (`lockedUntil.getTime() > Date.now()`), so the window this test measures is the
  // one an authenticated user's next login actually sees.
  //
  // This test does NOT fail on a reverted (naive) `locked_until` — verified, not
  // assumed (see the block comment above `describe` and docs/phase-10-plan.md §1/§5).
  // The column has no database default to defer to, so it's written and read entirely
  // in Node's own zone; the everyday Postgres-session-zone-vs-Node-zone mismatch the
  // two tests above catch never applies to it. What it's actually exposed to — a
  // shifted read that expires the lock instantly or stretches it across most of a
  // working day — needs Node's OWN zone to change between the write and a later read: a
  // restart onto a differently-zoned host, or a DST transition. No single Jest process
  // can reproduce that cheaply, which is why this test pins the functional claim rather
  // than guarding the conversion the way the two tests above do.
  it("a locked account's fifteen-minute window is fifteen minutes, not fifteen minutes plus a zone offset", async () => {
    const user = await dataSource.getRepository(User).save({
      name: 'Test User',
      role: UserRole.Staff,
      email: 'timestamps-lockout-test@example.com',
      passwordHash: 'unused-in-this-test',
    });

    // registerFailedLogin mutates `user` in place before persisting it — see
    // UsersService.persistLoginState — so calling it repeatedly on the same object
    // reproduces the real request-by-request path without needing to reload between
    // calls.
    const threshold = 5;
    for (let i = 0; i < threshold; i++) {
      await usersService.registerFailedLogin(user);
    }

    const reloaded = await dataSource
      .getRepository(User)
      .findOne({ where: { id: user.id } });
    expect(reloaded).not.toBeNull();
    expect(usersService.isLocked(reloaded!)).toBe(true);

    const remainingMs = reloaded!.lockedUntil!.getTime() - Date.now();
    const fifteenMinutesMs = 15 * 60_000;
    expect(remainingMs).toBeGreaterThan(fifteenMinutesMs - TOLERANCE_MS - 3_000);
    expect(remainingMs).toBeLessThanOrEqual(fifteenMinutesMs);
  });
});
