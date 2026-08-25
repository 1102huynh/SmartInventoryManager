# Configuration (`@nestjs/config`)

## Concept

`ConfigModule` reads environment variables (from `.env` and `process.env`) into a
`ConfigService` that the rest of the app can inject and query, instead of every file
reaching for `process.env.SOME_VAR` directly.

## Why NestJS uses it

Reading `process.env` directly scatters string-keyed, untyped access through the
codebase — a typo in an env var name fails silently (`undefined`, not an error), and
nothing documents what variables the app actually needs. Centralizing it in one typed
`configuration()` function (with defaults) makes required configuration visible in
one place and gives every consumer a typed value instead of a raw string.

## How it works in this project

`backend/src/config/configuration.ts` is the one place `process.env` is read
directly:

```ts
export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: { host: process.env.DB_HOST ?? '127.0.0.1', /* ... */ },
  auth: { jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me', /* ... */ },
  security: { maxFailedLoginAttempts: parseInt(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? '5', 10), /* ... */ },
});
```

Two sections were added after this note was first written: `auth` (Phase 3,
`docs/phase-3-plan.md`) — the JWT signing secret and token expiry — and `security`
(Phase 8, `docs/phase-8-plan.md`) — login-lockout thresholds and both throttlers'
limits. Both follow the same shape as `database`: typed fields with sensible local
defaults, read from `process.env` in exactly one place. `security.lockoutMinutes`
uses `parseFloat`, not `parseInt`, on purpose — the e2e suite needs a lockout window
measured in a fraction of a minute (a few seconds) to prove the lock auto-expires
without an actual fifteen-minute wait, and `parseInt` would truncate that to `0` and
defeat the test.

`AppModule` loads it via `ConfigModule.forRoot({ isGlobal: true, load: [configuration] })`
— `isGlobal: true` means any module can inject `ConfigService` without re-importing
`ConfigModule`. `DatabaseModule` was the first consumer, via `forRootAsync` (see
`docs/learning-notes/database-access.md` and the comment in
`backend/src/database/database.module.ts` for why the *async* variant is needed
here specifically: the database connection options depend on `ConfigService`, which
itself depends on `.env` having been parsed first) — `AuthModule`'s
`JwtModule.registerAsync` (the signing secret) and `AppModule`'s
`ThrottlerModule.forRootAsync` (the rate limits) later reused the same
`imports`/`inject`/`useFactory` shape, for the identical reason.

## Example

`backend/.env.example` documents every variable the app reads — `PORT`, `DB_HOST`,
`DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` for the portable local
Postgres in `tools/`; `JWT_SECRET`/`JWT_EXPIRES_IN` for auth; and
`AUTH_MAX_FAILED_ATTEMPTS`/`AUTH_LOCKOUT_MINUTES`/`THROTTLE_TTL_SECONDS`/
`THROTTLE_LIMIT`/`THROTTLE_LOGIN_TTL_SECONDS`/`THROTTLE_LOGIN_LIMIT` for rate
limiting and account lockout (see
`docs/learning-notes/authentication-and-guards.md`) — all with working defaults, so
copying it to `.env` gets the app running with zero further setup.

## Common Mistakes

- Committing a real `.env` file to version control — `.gitignore` at the project root
  excludes `**/.env` for this reason; only `.env.example` (no real secrets) is tracked.
- Reading `process.env` in a random service "just this once" instead of adding the
  variable to `configuration.ts` — it works, but it's now undocumented and untyped,
  defeating the entire point.
- Forgetting that `ConfigModule.forRoot()`'s default `.env` loading does **not**
  override a variable that's already set in `process.env` — this matters for the test
  suite, where `test/app.e2e-spec.ts` sets `process.env.DB_DATABASE` *before*
  importing `AppModule`, specifically relying on that precedence to redirect the app
  at a separate test database.

## Key Takeaways

- One typed `configuration()` function is the single source of truth for what env
  vars exist and their defaults.
- `ConfigModule.forRoot({ isGlobal: true })` avoids re-importing it everywhere.
- `forRootAsync` + `inject`/`useFactory` is the pattern for anything (like a database
  connection) that needs config values before it can be constructed.
