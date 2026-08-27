# Testing Strategy: Unit, Integration, and E2E

## Concept

This project uses three distinct kinds of automated test, each proving a different
thing and each willing to pay a different cost for it:

- **Unit test** — one class, dependencies replaced with fakes, no database, no HTTP.
- **Integration test** — real code talking to a real database, but skipping HTTP.
- **E2E (end-to-end) test** — the real, fully wired app, driven only through real
  HTTP requests, exactly the way the frontend (or `curl`) would.

## Why this project uses all three

Each layer catches a different class of mistake, and using only one leaves a gap:

- A **unit** test (`suppliers.service.spec.ts`) is fast and precise — it can assert
  "this method calls the repository with exactly this filter" — but it can't tell you
  whether a real Postgres database would actually enforce a constraint or honor a
  lock, because there's no real database involved.
- An **integration** test (`inventory.service.integration.spec.ts`) closes that gap
  for the one piece of logic in this project where "does the mock behave like the
  real thing" actually matters: the pessimistic row lock in
  `InventoryService`'s write methods (see `database-transactions.md`). A mocked
  repository has no concept of locking two concurrent transactions against each
  other — only a real database can prove that behavior.
- An **e2e** test (`test/app.e2e-spec.ts`) proves the layers actually connect: that
  `ValidationPipe` really rejects a bad request before it reaches a controller, that
  a thrown `ConflictException` really becomes a `409` over real HTTP, that
  `AllExceptionsFilter` really hides internal errors from the response body. None of
  the other two levels touch the HTTP layer at all.

## How it works in this project

- `npm test` runs everything matching `*.spec.ts` under `src/` — the unit tests
  (`suppliers.service.spec.ts`, fast, mocked repository) and the integration tests
  (`inventory.service.integration.spec.ts` and, since Phase 10,
  `timestamps.integration.spec.ts` — slower, need the local Postgres from `tools/`
  running, target the separate `smart_inventory_test` database).
- `npm run test:e2e` runs every `*.e2e-spec.ts` under `test/` — `app.e2e-spec.ts`,
  and five more added since as each phase needed its own end-to-end coverage:
  `auth.e2e-spec.ts` (Phase 3), `roles.e2e-spec.ts` and `categories.e2e-spec.ts`
  (Phase 5), `users.e2e-spec.ts` (Phase 6), `audit.e2e-spec.ts` (Phase 9) — all six
  against the separate `smart_inventory_e2e` database, booting the actual `AppModule`
  with the same `ValidationPipe`/`AllExceptionsFilter`/`ClassSerializerInterceptor`
  setup `main.ts` uses.

Two *different* physical test databases (`smart_inventory_test` and
`smart_inventory_e2e`), not one — Jest can run test files in parallel, and the
integration test's `dropSchema: true` setup would otherwise race against the e2e
test's own data.

That same "Jest runs files in parallel" fact bites *within* the e2e layer too, once
there's more than one e2e spec file: every file above `TRUNCATE`s/seeds the *same*
`smart_inventory_e2e` database in its own `beforeEach`, so running them in separate
parallel workers lets one file's truncate wipe out data another file's test is
mid-way through using (surfaced as flaky, seemingly unrelated failures — a SKU that
should have been unique to one test colliding with a leftover row from another
file's last run). `test:e2e`'s npm script passes `--runInBand` specifically to force
all e2e files onto one worker, in sequence, for exactly this reason. This wasn't
needed back when there was only one e2e file to run.

## A test with an unasserted ambient dependency can silently prove nothing (Phase 10)

Some tests only discriminate between correct and incorrect behavior when the
environment is in a particular state. **If a test needs an environmental condition in
order to be able to fail, assert that condition and fail loudly when it is absent.**
Otherwise the test still passes when the condition is missing — and a pass then means
"nothing was checked," which is indistinguishable from "everything is fine" in a green
suite. That is worse than having no test, because the missing test would at least be
missing.

`timestamps.integration.spec.ts` (Phase 10, `docs/phase-10-plan.md` §5) is this
project's worked example. It proves that a `timestamptz` column round-trips to the
right instant, and it can only fail if **Postgres's session zone and Node's zone have
different offsets** — that difference is the entire mechanism it exercises. Point the
suite at a host where the two coincide and every assertion passes without testing
anything. So `beforeAll` reads Postgres's session offset, compares it against Node's,
and throws if they match. Compare *offsets*, not zone names: `Asia/Bangkok` and
`Asia/Ho_Chi_Minh` are different names for the same UTC+7.

This is not hypothetical. The first version of that test had no guard, proved nothing,
and was green — see below.

### The Jest / `TZ` trap specifically

`auth.e2e-spec.ts` sets `process.env.THROTTLE_LOGIN_LIMIT` and
`process.env.AUTH_LOCKOUT_MINUTES` at the top of the file, above the imports, and that
works: nothing reads those values until `ConfigService` looks them up at runtime, well
after the assignment.

**`TZ` does not behave that way, and copying the pattern to it fails silently.**
Timezone-sensitive `Date` behavior can already have been initialized during Node/Jest
bootstrap, before a test file's top-level statements run — on this project's setup, a
`new Date().getTimezoneOffset()` check placed immediately after
`process.env.TZ = 'America/Los_Angeles'` still reported the original zone. The first
version of the Phase 10 test relied on that assignment to create the zone mismatch it
needed, never got one, and passed anyway.

Two rules follow, and they are the general form, not a note about `TZ`:

- A working environment-variable pattern is only transferable to values read at
  **runtime**. Anything consumed during process bootstrap needs a different mechanism —
  for the Phase 10 test, pinning Postgres's session zone per connection
  (`options: '-c timezone=<zone>'`, via `createTestDataSource()`'s optional `extra`),
  which applies at connection-open time and has no caching to fight.
- Never assume an environment assignment took effect. **Assert the resulting state** —
  the offset, not the variable — and let the test fail loudly if it did not.

## Example

The exact same business rule — "a stock-out can't exceed current stock" — is proven
at two different levels on purpose: as a focused integration test
(`rejects a stock-out that would exceed current stock, and leaves stock unchanged`)
and again as part of a full HTTP round trip in the e2e suite. That's not duplication;
each one is proving something the other can't.

## Common Mistakes

- Using a mocked repository for something concurrency-sensitive — it can't tell you
  anything true about the real database's locking behavior.
- Running integration/e2e tests against the same database the dev server uses — they
  truncate tables between tests, which would wipe out whatever's in the dev database.
  This project uses three separate databases for exactly this reason: dev
  (`smart_inventory`), integration tests (`smart_inventory_test`), e2e tests
  (`smart_inventory_e2e`).
- Assuming an environment variable set at the top of a spec file took effect. It does
  for values read later at runtime (`ConfigService`); it does not for anything consumed
  during process bootstrap, such as `TZ` — assert the resulting state instead.
- Treating "the tests pass" as proof the *frontend* works — the e2e suite proves the
  API works over real HTTP; only actually driving the UI (as the frontend smoke test
  in this phase's transcript did, via a headless browser hitting the real running
  backend) proves the two are wired together correctly.

## Key Takeaways

- Unit tests are fast and precise but can't validate real database behavior.
- Integration tests exist specifically for logic a mock can't faithfully stand in for
  — in this project, that's the row-locking in `InventoryService`.
- E2E tests are the only layer that proves the HTTP pipeline (pipes, filters,
  controllers, services, database) is actually wired together correctly.
- Isolate test databases from the dev database and from each other.
- If a test can only fail when the environment is in a particular state, assert that
  state — an unasserted ambient dependency turns a passing test into no test at all.
