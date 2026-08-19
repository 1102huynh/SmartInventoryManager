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

- `npm test` runs everything matching `*.spec.ts` under `src/` — both the unit test
  (`suppliers.service.spec.ts`, fast, mocked repository) and the integration test
  (`inventory.service.integration.spec.ts`, slower, needs the local Postgres from
  `tools/` running, targets the separate `smart_inventory_test` database).
- `npm run test:e2e` runs `test/app.e2e-spec.ts` against the separate
  `smart_inventory_e2e` database, booting the actual `AppModule` with the same
  `ValidationPipe`/`AllExceptionsFilter` setup `main.ts` uses.

Two *different* physical test databases (`smart_inventory_test` and
`smart_inventory_e2e`), not one — Jest can run test files in parallel, and the
integration test's `dropSchema: true` setup would otherwise race against the e2e
test's own data.

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
