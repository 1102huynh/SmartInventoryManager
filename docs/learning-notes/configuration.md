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
});
```

`AppModule` loads it via `ConfigModule.forRoot({ isGlobal: true, load: [configuration] })`
— `isGlobal: true` means any module can inject `ConfigService` without re-importing
`ConfigModule`. `DatabaseModule` is the main consumer, via `forRootAsync` (see
`docs/learning-notes/database-access.md` and the comment in
`backend/src/database/database.module.ts` for why the *async* variant is needed
here specifically: the database connection options depend on `ConfigService`, which
itself depends on `.env` having been parsed first).

## Example

`backend/.env.example` documents every variable the app reads (`PORT`, `DB_HOST`,
`DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`) with working defaults for the
portable local Postgres in `tools/` — copy it to `.env` and the app runs with zero
further setup.

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
