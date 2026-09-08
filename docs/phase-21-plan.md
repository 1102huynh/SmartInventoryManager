# Phase 21 Plan — Shared throttle store (Postgres-backed)

Status: Phase 21 — Implemented
Last updated: 2026-09-08
Scope decided with the project owner: **give `@nestjs/throttler` a shared, durable
store backed by the Postgres this app already runs on, replacing its default
per-process `Map`, so the configured limits still mean what they say when the API runs
as more than one instance** — and nothing else. This is issue #11, and it is the
successor Phase 8 §7 named by hand:

> **A shared throttle store (Redis or Postgres-backed)** — the in-memory default is
> correct for a single process and wrong for several. Recorded in
> `architecture-observations.md` as a named precondition for scaling out (§4), not
> solved here.

The owner has confirmed the trigger `architecture-observations.md` set for it — "if
this app is ever deployed with more than one running instance in front of the same
clients" — is now met: a multi-instance deployment is planned. The owner also chose
**Postgres over Redis** for the store (see §1), and asked for this plan to be reviewed
before implementation.

Scoped the same way every phase in this series has been: one headline change, an
explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

Phase 8 built two rate-limiting controls and **deliberately gave them different
storage** (`architecture-observations.md`, "two rate-limiting mechanisms, two storage
models"):

- **Account lockout** — `failed_login_attempts` / `locked_until` on `users`, in
  Postgres, because "state that must survive a restart goes in Postgres" (Phase 8 §1).
- **The request throttle** — `@nestjs/throttler`'s default in-memory `Map`, alive only
  for the life of one Node process.

That split was correct for a single process and was flagged, at the time, as a named
**unenforced precondition**: the moment the app runs as N instances behind the same
clients, the lock keeps working unchanged (Postgres is shared) but the throttle
silently becomes per-instance and permits N× the configured rate — "no error, no
warning, just a quietly weaker limit."

**Honesty about the trigger, in the register this project uses:** nothing is broken
today. The app runs as one process (`tools/README.md`), `req.ip` is honest, and both
Phase 8 controls are exactly as correct as they were designed to be. What makes now the
time is that the condition `architecture-observations.md` wrote down has been reached
by an actual deployment decision, not a hunch — and this project's standard (Phase 20's
own framing) is to act on a trigger once it is genuinely met, having declined to act
before.

**This is the first of this file's "three named unenforced preconditions" to be
closed.** The other two — the best-effort audit write (BR-082) and the last unbounded
catalogue read (`GET /categories` → the `CATEGORIES` cache) — are untouched. After this
phase the throttle store moves from the "silently invalidated by a second process" side
of the ledger to the "durable, shared, same as everything else" side, and
`architecture-observations.md` records the closure the way Phase 10 recorded closing
the `timestamptz` question — an entry that finally shrinks rather than grows.

---

## 1. Design decisions

### Postgres, not Redis — the store this app already has, not a new one to run

The issue title says "Redis-backed" because that is the throttler ecosystem's default
answer. The owner chose Postgres, and the reasoning is specific to this project rather
than general advice:

- **A durable shared store already exists here, and it is Postgres.** Account lockout
  (Phase 8), the audit log (Phase 9), every entity — all Postgres. Redis would be the
  first piece of infrastructure in this system that is not the database: a second
  service to run locally (`tools/` provisions Postgres and nothing else), a second
  service to run in production, a second thing to secure, back up, monitor, and reason
  about when it is down.
- **CI stays as it is.** `ci.yml` spins up one `postgres:17` service container per job.
  A Redis store means a second `services:` block in two jobs and a new connection
  string; a Postgres store means the integration and e2e jobs already have everything
  they need.
- **The write volume is trivial and self-capping.** The throttle writes one row per
  `(client, route, throttler)` per request, and the tight limits that would drive real
  volume are on exactly three routes (`POST /auth/login`, `PATCH /auth/password`, and
  the global backstop everything else inherits at 120/60s). One small indexed upsert on
  the connection pool every request already uses is noise next to the queries a normal
  page load fires.
- **The seam is clean if Redis is ever actually justified.** `@nestjs/throttler`'s
  storage is a one-method interface (`ThrottlerStorage.increment`) selected by a single
  `storage:` option. Swapping in `@nest-lab/throttler-storage-redis` later, *if a
  measured load problem ever appears*, is a one-module change — the same "extract when
  there is evidence, not before" principle `architecture-observations.md` applies to the
  Go and Kafka questions.

The cost being accepted: a `SELECT`-and-`UPSERT` per throttled request where the
in-memory store did a `Map` lookup. Quantified above and revisited in §7 as the thing a
future Redis switch would be measured against.

### What we are implementing: `ThrottlerStorage.increment`

`@nestjs/throttler` v6 resolves its store through one provider — `ThrottlerStorage` —
and `ThrottlerModule` will use whatever object is passed as the `storage:` option
instead of constructing its default `ThrottlerStorageService`. The interface is a
single method:

```ts
increment(
  key: string,        // already sha256-hashed by the guard: hash(`${ControllerName}-${handler}-${throttlerName}-${tracker}`)
  ttl: number,        // milliseconds
  limit: number,
  blockDuration: number, // milliseconds; defaults to ttl when no @Throttle sets it (our case)
  throttlerName: string,
): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }>
```

`timeToExpire` / `timeToBlockExpire` are **seconds**. The guard throws (our
`AppThrottlerGuard.throwThrottlingException`, unchanged from Phase 8) whenever
`isBlocked` is true, and sets `Retry-After: timeToBlockExpire`.

The `key` is opaque and fully qualified — it already folds in the client tracker
(`req.ip`), the controller, the handler, and the throttler name — so the store needs
no knowledge of IPs or routes. It stores counts against a string key and nothing else.

### Fixed window, not the default store's per-hit sliding expiry — deliberate

The stock `ThrottlerStorageService` schedules a `setTimeout` per hit that decrements the
counter one `ttl` later, which makes its not-yet-blocked phase behave like a sliding
window. Reproducing that in Postgres would mean a row per hit and a sweep, for a
fidelity difference no configuration in this app can observe.

Phase 21 implements a **fixed window**: one row per key carrying `hits` and an
`expires_at`; each `increment` bumps `hits` and, once `expires_at` has passed, resets
`hits` to 1 and `expires_at` to `now() + ttl`. This is:

- **What the Redis-community storage does too** (`INCR` + `PEXPIRE`), so choosing
  Postgres does not also mean choosing a semantics no other backend uses.
- **Easier to reason about** — "N requests per window, window resets on the first
  request after it lapses."
- **Within tolerance at these limits.** A fixed window lets a client that times its
  requests around the boundary get up to `2N` through in a `2·ttl` span. For a 120/60s
  backstop and a 10/300s login limit protecting a 1–10 person business, that burst is
  not a meaningful weakening — the same "quantify the security cost and check it is
  small" move Phase 8 §1 made for the flat fifteen-minute lockout window.

Stated here because a reviewer comparing this store against the default's source will
see the difference and should see that it was chosen, not missed.

### `blockDuration` is treated as equal to `ttl` — no `blocked_until` column yet

Nothing in this app sets `blockDuration` (no `@Throttle({ default: { blockDuration }})`
anywhere), so the guard always passes `blockDuration === ttl`. With that equality,
"blocked" and "over the limit while the window is still open" are the same state, and
`isBlocked` collapses to `hits > limit` computed from the row this phase already stores.
`timeToBlockExpire` is then just `timeToExpire`.

A dedicated `blocked_until` column — to hold a block that outlives its window — is
**not** added. It would be a column no code path writes a distinct value to, which is
exactly the "not a new `login_attempts` table" call Phase 8 §1 made: build the two
fields the feature needs, park the rest. If a future phase configures a real
`blockDuration`, adding `blocked_until` and one CASE branch is where that work goes
(§7).

### The table: `throttle_hits` — a cache, not a record, so no audit columns

```
throttle_hits
  key         text        PRIMARY KEY   -- the guard's sha256 hex; text so a custom key generator can't overflow it
  hits        integer     NOT NULL
  expires_at  timestamptz NOT NULL      -- server-set operational state, timestamptz per domain-model.md §8's resolved convention
```

**No `created_at` / `updated_at`.** `domain-model.md` §8's convention governs *audit*
columns — "when was this row written / last changed" — and this table has no audit
question to answer. Its rows are disposable throttle counters that the next request
overwrites and a sweep deletes; recording when one was created would be a column whose
value nothing reads, the same reasoning that keeps `updated_at` off the immutable
tables. `expires_at` is server-set operational state and never user-supplied, so it is
`timestamptz`, following the `users.locked_until` precedent (Phase 8 §1, converted in
Phase 10) rather than starting a plain-`timestamp` island.

This table is **not a domain entity** — it models nothing in `product.md` and appears
in no `domain-model.md` relationship. It is an operational/cache table that exists
because the throttler needs somewhere shared to count. `domain-model.md` gets one
sentence saying so (§4), not a new section.

### Fork A — how the storage class talks to Postgres. Recommended: a `@Entity` + raw parameterised SQL

The `increment` must be **one atomic statement** (see "race-free," below), which rules
out read-then-write through the repository API and pushes past what QueryBuilder
expresses comfortably (two `CASE` expressions with `ON CONFLICT`).

- **A1 — a `ThrottleHit` `@Entity`, and the storage class runs the upsert as
  `repository.query(sql, params)` with a hand-written, parameterised statement.** The
  entity earns its place: `synchronize: true` builds the table for the integration test
  database (`test-data-source.ts`), and it registers in the three entity lists the same
  way every entity in this repo does. The raw SQL lives next to it, parameterised (no
  interpolation), in the same register the migrations are already written in.
  **Recommended.**
- **A2 — no entity; the storage class injects `DataSource` and issues raw SQL only.**
  Rejected: the integration test database (`synchronize`, no migrations) would then have
  no `throttle_hits` table at all, and the entity is the established way this project
  keeps the CLI, the app connection, and the test connection agreeing on the schema.

The statement:

```sql
INSERT INTO throttle_hits AS t (key, hits, expires_at)
VALUES ($1, 1, now() + $2 * interval '1 millisecond')
ON CONFLICT (key) DO UPDATE SET
  hits = CASE WHEN t.expires_at <= now() THEN 1
              ELSE LEAST(t.hits + 1, $3 + 1) END,
  expires_at = CASE WHEN t.expires_at <= now() THEN now() + $2 * interval '1 millisecond'
                    ELSE t.expires_at END
RETURNING hits AS "totalHits",
          GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::int AS "timeToExpire";
```

`$1 = key`, `$2 = ttl` (ms), `$3 = limit`. Then in the storage class:

```ts
const { totalHits, timeToExpire } = (await this.repo.query(SQL, [key, ttl, limit]))[0];
const isBlocked = Number(totalHits) > limit;
return {
  totalHits: Number(totalHits),
  timeToExpire: Number(timeToExpire),
  isBlocked,
  timeToBlockExpire: isBlocked ? Number(timeToExpire) : 0,
};
```

`LEAST(t.hits + 1, $3 + 1)` caps the stored count at `limit + 1` — it keeps a hot row
from climbing without bound under a sustained flood and keeps `X-RateLimit-Remaining`
arithmetic sane; the exact over-limit count is not information anything needs.

### Race-free by construction — unlike Phase 8's account counter

`INSERT … ON CONFLICT DO UPDATE` is a single statement; Postgres takes a row lock on the
conflicting row, so two simultaneous requests for one key serialise and increment to 2,
never to 1-and-1. Phase 8 §1 explicitly accepted a lost-update race on
`registerFailedLogin` ("two simultaneous failed logins … can race and record one
increment instead of two") because a row lock was not worth it at that scale. Here the
atomic upsert costs nothing extra and removes the race, so this store does not carry
Phase 8's caveat. Worth a one-line comment in the storage class saying why it does not.

### Fork B — `UNLOGGED` table or a plain one. Recommended: `UNLOGGED`, with the divergence named

An `UNLOGGED` table writes no WAL: faster writes, and its contents are truncated after
an unclean shutdown. For a throttle store that is close to ideal — the data is
ephemeral by nature, and losing it in a crash just means the limits reset (a few
seconds of a wider limit right after a database crash, which is not the failure anyone
is worried about).

- **B1 — `CREATE UNLOGGED TABLE throttle_hits` in the migration.** Signals "this is a
  cache" in the schema itself, and takes the per-request write off the WAL path.
  **Recommended.** *Named cost:* TypeORM cannot express `UNLOGGED` through decorators,
  so the integration test database (`synchronize: true`) builds `throttle_hits` as an
  ordinary `LOGGED` table. That is a real dev/prod schema divergence — behaviourally
  invisible (durability and replication differ, nothing a test asserts), and the same
  *shape* of documented, expected difference this project already lives with for the
  `@Check` constraint names (Phase 18) and the index DESC/ASC split. The migration
  header comment records it.
- **B2 — a plain `LOGGED` table, identical everywhere.** The zero-divergence option,
  consistent with this project's strong "no second convention" instinct (Phases 7, 8,
  10). Costs the WAL write per throttled request — trivial at this volume — and loses
  the "this is a cache" signal.

This is the one fork where the owner may reasonably override the recommendation: the
divergence in B1 is small but real, and "keep it boring" has carried a lot of weight in
this codebase.

### Fork C — reclaiming expired rows. Recommended: an opportunistic probabilistic sweep

One row exists per `(client IP, controller, handler, throttler)` tuple. For a small
business that is bounded and mostly self-recycling — the same client hitting the same
route reuses its row. The unbounded case is a distributed scanner touching many routes
from many addresses: each such request mints a row that may never be revisited.

- **C1 — inside `increment`, with small probability, fire a background
  `DELETE FROM throttle_hits WHERE expires_at <= now()`.** No dependency, self-limiting
  (~1 request in 1000 pays a cheap indexed delete), and errors are swallowed the way
  BR-082's best-effort audit write swallows a repository failure — a sweep that fails
  must never fail the request. **Recommended.**
- **C2 — a scheduled sweep via `@nestjs/schedule`.** Rejected: a new runtime dependency
  for one `DELETE`, against this codebase's repeated refusal to add dependencies
  (`serve.js`, the bundler, Phase 14's single devDependency).
- **C3 — no sweep, rely on row reuse.** Rejected: leaves the distributed-scan case
  growing without bound, with nothing to reclaim it.
- **C4 — a one-shot sweep on `OnApplicationBootstrap`.** Cheap and worth adding
  *alongside* C1 (every deploy/restart clears the backlog), but not sufficient alone on
  a long-lived instance.

Recommendation: **C1 + C4.**

### Fork D — index on `expires_at`. Recommended: include it

`IDX_throttle_hits_expires_at` on `(expires_at)` supports the sweep's
`WHERE expires_at <= now()`. The table is small, but the sweep runs on request threads
(C1), so keeping it a cheap index scan rather than a growing seq scan matters. Adding an
index in its own right has precedent (Phase 11's `occurred_at` index).

### Fork E — `trust proxy`, and this is the phase's one real scope fork. Recommended: include it

Phase 8 §1 flagged, as "a deployment note, not a code change," that `req.ip` is only
honest if Express is told whether it sits behind a proxy — and that behind an
unconfigured load balancer "every request will appear to come from one address and the
throttle will lock out the world." README repeats it; Phase 9 sharpened it (the audit
log records that same address).

**Phase 21 makes that note load-bearing.** The entire point of this phase is a throttle
that is correct across multiple instances — and multiple instances almost always means
a load balancer in front. A *shared* store keyed on the balancer's single IP is a
worse throttle than the per-instance one it replaces: it would now correctly agree, across every
instance, that the whole world is one client. Shipping the shared store without fixing
the tracker delivers a multi-instance throttle that is still wrong.

- **E1 — add `TRUST_PROXY` (env) → `configuration.ts` → `app.set('trust proxy', …)` in
  `main.ts`.** Parse: unset → Express default (off, honest `req.ip` for direct
  connections, unchanged for local dev); `true`/`false` → boolean; an integer → trusted
  hop count; anything else → passed through (Express accepts `'loopback'`, a CSV of
  IPs/subnets). `.env.example` documents it, replacing the "not a code change" caveat.
  **Recommended** — the shared store is not actually done for its stated purpose
  without it.
- **E2 — keep it out, ship the store alone.** Then the deployment runbook *must* set
  `trust proxy` another way, and `architecture-observations.md` records that the
  tracker-behind-proxy gap is now the live risk in place of the per-instance one. A
  coherent stop only if the owner wants a strictly single-headline phase; the plan
  recommends against it.

### No new FR, no new BR

`requirements.md` is a *functional* requirements document and no user goal changes —
Phase 8 already recorded "resist password guessing" as a capability with no FR behind
it, and this phase only changes where the throttle keeps its count. BR-079 (auth
attempts are rate-limited) and BR-080 (consecutive failures lock an account) read
exactly as before; the store swap does not touch what the rules say, only whether they
hold with more than one process. So: a no-FR note (the Nth) and a no-BR line (the Nth),
each with its reason, keeping both documents honest — the Phase 7/10/11/19/20 pattern.

---

## 2. What's new (backend)

### Dependency

**None.** `@nestjs/throttler` (already present, v6.5.0) supports a custom `storage:`
out of the box. No `ioredis`, no `@nest-lab/throttler-storage-redis`, no
`@nestjs/schedule`.

### `throttle_hits` table + migration

`1788010000000-AddThrottleHitsTable.ts` (any timestamp sorting after
`1787930000000-AddStockOutReasonCategory`):

```
up:
  CREATE [UNLOGGED] TABLE "throttle_hits" (
    "key" text PRIMARY KEY,
    "hits" integer NOT NULL,
    "expires_at" timestamptz NOT NULL
  )
  CREATE INDEX "IDX_throttle_hits_expires_at" ON "throttle_hits" ("expires_at")

down:
  DROP INDEX "public"."IDX_throttle_hits_expires_at"
  DROP TABLE "throttle_hits"
```

Purely additive — no backfill, nothing references it, safe against the seeded dev
database and an empty one alike. Header comment records: why it exists, why no audit
columns, the `UNLOGGED` decision and the resulting `synchronize`-builds-it-`LOGGED`
divergence (Fork B), and that `run-seed.ts` writes nothing here.

### `backend/src/throttler/` — three small files

| File | What it is |
|---|---|
| `throttle-hit.entity.ts` | `@Entity('throttle_hits')` — `key` `@PrimaryColumn('text')`, `hits` `int`, `expiresAt` `timestamptz` (`name: 'expires_at'`). No `@Exclude` needed; it is never serialised into any response. |
| `postgres-throttler.storage.ts` | `@Injectable() class PostgresThrottlerStorage implements ThrottlerStorage`. Injects the `ThrottleHit` repository. `increment(...)` = the §1 upsert + result mapping; C1 opportunistic sweep with swallowed errors. Implements `OnApplicationBootstrap` for the C4 one-shot sweep. Carries the "atomic, therefore race-free — contrast Phase 8's counter" comment and the "fixed window, deliberately — see plan §1" comment. |
| `throttler-storage.module.ts` | Imports `TypeOrmModule.forFeature([ThrottleHit])`; provides and **exports** `PostgresThrottlerStorage`. |

### `app.module.ts` — wire the store into `ThrottlerModule`

```ts
ThrottlerModule.forRootAsync({
  imports: [ThrottlerStorageModule, ConfigModule],
  inject: [ConfigService, PostgresThrottlerStorage],
  useFactory: (config: ConfigService<AppConfig, true>, storage: PostgresThrottlerStorage) => ({
    storage,
    throttlers: [ /* unchanged: name 'default', ttl/limit from security.* config */ ],
  }),
}),
```

The `throttlers` array, the `security.*` config keys, `AppThrottlerGuard`, and the
guard's registration order in `AuthModule` are **all unchanged**. This phase changes
*where the count is kept*, nothing about the limits or the pipeline.
`TypeOrmModule.forFeature` in `ThrottlerStorageModule` resolves against the root
connection `DatabaseModule` already registers — Nest builds the full provider graph, so
import order in `AppModule` does not matter here.

### `configuration.ts` + `.env.example` — `TRUST_PROXY` (Fork E, if taken)

`trustProxy` at the top level of `AppConfig` (an HTTP-server concern, not a
`security.*` policy number), read from `process.env.TRUST_PROXY` with the parse rules in
§1 Fork E. `.env.example` gains it with a comment that supersedes the existing
"if this app ever runs behind a reverse proxy" note.

### The three entity registries

`ThrottleHit` is added to the `entities: [...]` array in **`data-source.ts`** (CLI /
migrations), **`test-data-source.ts`** (integration tests), and **`database.module.ts`**
(the running app) — the same three places every entity in this repo is listed.

### No DTO, no route, no controller change, no `run-seed.ts` change

Nothing accepts or returns throttle state; no seed writes it.

---

## 3. Frontend changes

**None.** Stated because a reader will check. A `429` already renders correctly (Phase 8
§3 wired `Store._request` to fall through to the generic error display, and named `429`
in the `403` comment so it is not folded into the session-death branch). This phase does
not change the `429` body, its status, or when it fires from a well-behaved client's
point of view — only that two instances now agree on the count. No `frontend/` file
changes, and the `node --test` suite is not touched or re-run.

---

## 4. Documentation updates

1. **`architecture-observations.md`** — a Phase 21 cross-cutting section that **closes**
   the throttle-store half of "two rate-limiting mechanisms, two storage models." The
   precondition Phase 8 named is retired: the throttle count now lives in Postgres,
   shared, the same as account lockout — the split that section describes is gone. Note,
   in that section's own register, that this is the **first** of the file's three named
   unenforced preconditions to be closed rather than carried (the audit-write and the
   `GET /categories` cache remain), and why now (the deployment trigger met, Phase 20's
   "act once the trigger is genuinely met" standard). Record the two deliberate
   divergences from the default store — fixed window vs. per-hit expiry, and (if Fork B1)
   `UNLOGGED` in prod / `LOGGED` under `synchronize` — as expected, documented
   differences, not drift.

2. **`business-rules.md`** — a "no new BR" line, with its reason: BR-079/BR-080 are
   unchanged; a storage backend is not a business rule. Cross-reference from neither —
   this is an implementation note.

3. **`requirements.md`** — an "Auth hardening store (Phase 21 — no new FR)" note beside
   the existing Phase 8/20 ones: no user goal changes; the rules are in
   `business-rules.md`; recording the absence keeps the FR table honest.

4. **`api.md`** — title bumped to Phase 21. The `429` section gains one sentence: the
   limit is now enforced consistently across API instances (previously per-instance).
   No route table change.

5. **`README.md`** — Current phase to Phase 21; Phase 20 moves to "Earlier phases". Note
   the new migration (`npm run migration:run` picks up `throttle_hits`), that the
   throttle now shares Postgres with account lockout, and — if Fork E — replace the
   `trust proxy` caveat paragraph with the `TRUST_PROXY` setting.

6. **`docs/learning-notes/`** — extend `authentication-and-guards.md` (which already
   owns the throttler material from Phase 8) with: the `ThrottlerStorage` one-method
   seam and how a custom store is selected (`storage:` option + a provider module),
   why per-process default stores are a multi-instance trap, and the fixed-window vs.
   sliding-window trade-off with the "the ecosystem's Redis store makes the same choice"
   note.

7. **`product.md` §11** — a one-line Phase 21 entry in the "no scope change" shape
   (§4/§5/§7 unchanged, issue #11 / Phase 8 §7 named).

8. **`domain-model.md`** — one sentence (in §8 or a short "operational tables" aside):
   `throttle_hits` is an operational/cache table, not a domain entity, and deliberately
   carries no audit columns. No section, no relationship.

Phase 8's §7 line and `architecture-observations.md`'s existing Phase 8 section are
**left as written** — dated records of what was true then; the Phase 21 section is where
"now done" is recorded.

---

## 5. Testing plan

Two properties are easy to get silently wrong — a window that never resets, and a store
that is not actually shared — and each gets a pinning test.

- **Integration — `backend/src/throttler/postgres-throttler.storage.integration.spec.ts`
  (new, real Postgres via `createTestDataSource()`).** This is where the SQL semantics
  are proven, consistent with the project's "DB behaviour is covered at the integration
  layer" split:
  - First `increment(key, ttl, limit, ttl, 'default')` → `totalHits: 1`,
    `isBlocked: false`, `timeToExpire` ≈ `ttl/1000`.
  - `limit` calls → `totalHits` climbs to `limit`, never `isBlocked`; call `limit + 1` →
    `isBlocked: true`, `Retry-After`-shaped `timeToBlockExpire > 0`.
  - **Window expiry** — with `ttl` ≈ 100 ms, exceed the limit, `await` ~150 ms, call
    again → `totalHits` back to `1`, `isBlocked: false`. The analogue of Phase 8's
    lockout auto-expiry test: proves the window *resets*, not merely that a counter was
    set.
  - **Race-free** — `Promise.all` of K concurrent `increment`s on one key → final
    `totalHits` is exactly `min(K, limit + 1)`, never less. Pins the property §1 claims
    the atomic upsert buys and Phase 8's counter deliberately does not.
  - The sweep deletes rows whose `expires_at` has passed and leaves live ones.

- **E2E — `auth.e2e-spec.ts` (extended).**
  - Add `throttle_hits` to the file-level `beforeEach` `TRUNCATE`, and to the
    `rate limiting on POST /auth/login` block's `beforeEach`. That block's isolation
    previously came from "a fresh app per test = a fresh in-memory counter"; with a
    shared store that no longer resets anything, so the **truncate** is what isolates
    now. Update the block's long explanatory comment to say so — the fresh-app-per-test
    setup becomes redundant for counter isolation (harmless to leave, but the comment
    must no longer claim it is what provides the clean slate).
  - The two existing throttle assertions (429 body shape + `Retry-After`; over-limit
    request with the correct password still 429) pass unchanged once the truncate is in
    place.
  - **New — the store is shared.** Build two `INestApplication`s against the same
    database, `appA` and `appB`, with the login limit set low. Exhaust the limit through
    `appA`; then a single request to `appB` from the same client returns `429`
    immediately. This is the headline behaviour and the reason the phase exists — the
    default in-memory store would let `appB` through. It is the change-test counterpart
    to Phase 8's "a locked account's token still works" non-change test.

- **All other e2e specs — add `throttle_hits` to their `TRUNCATE` lists.** One table
  name in ~8 strings. Each spec already truncates its own tables per `beforeEach`; the
  shared throttle row keyed on `127.0.0.1` would otherwise accumulate hits across a
  whole suite run. The e2e env's `THROTTLE_LIMIT=10000` / `THROTTLE_LOGIN_LIMIT=1000`
  absorb a run comfortably, but truncating is the clean, uniform fix and keeps a future
  limit change from silently making the suite flaky.

- **CI.** The `test` job's new integration spec runs against `smart_inventory_test`
  (`synchronize` builds `throttle_hits` from the entity — `LOGGED`, per Fork B). The
  `e2e` job runs the migration chain from empty, which now includes
  `1788010000000-AddThrottleHitsTable` — the first thing to exercise it against a fresh
  database. No workflow file change.

- **No unit test** for the storage class — it is entirely SQL semantics, which the
  integration spec covers; a unit test would mock the query and assert nothing real,
  the same reason Phases 3–20 keep pure-DB behaviour out of the unit layer.

- **Existing unit + integration suites** — untouched. Nothing they cover changes; the
  storage is only constructed when the full `AppModule` boots.

---

## 6. Rollout order

Each step leaves the suite green and is a no-op from a well-behaved client's point of
view until step 3.

1. **`ThrottleHit` entity + migration + the three entity registries + `throttle_hits`
   added to every e2e `TRUNCATE`.** Nothing reads the table yet. Full suite green —
   the migration applies from empty (e2e), `synchronize` builds it (integration), and
   the extra truncate is inert while the table is always empty. De-risks the schema
   change alone.
2. **`PostgresThrottlerStorage` + `ThrottlerStorageModule` + the integration spec.**
   The store is tested in isolation; still not wired into the guard, so app behaviour is
   unchanged.
3. **Wire `storage:` into `ThrottlerModule.forRootAsync`; rework the
   `auth.e2e-spec.ts` rate-limiting block (truncate-based isolation) and add the
   cross-instance test.** **The feature lands here** — the throttle now counts in
   Postgres. Full suite green.
4. **Fork E — `TRUST_PROXY` in `configuration.ts` + `main.ts` + `.env.example`.**
   Independent of 1–3; skippable as a unit only if the owner cuts Fork E.
5. **Documentation (§4)** — the `architecture-observations.md` closure, the no-FR / no-BR
   notes, the learning note, README, `api.md`, `product.md`, `domain-model.md`. Not
   optional; the closed-precondition record is the deliverable that outlasts the code.

Steps 1–2 are individually shippable and observably no-ops; if step 3 goes wrong,
everything before it can stay.

---

## 7. Explicitly out of scope for Phase 21 (Future)

- **A Redis (or any non-Postgres) throttle store.** The `ThrottlerStorage` seam makes
  it a one-module swap; do it only if a *measured* load problem appears — the store now
  in place is what that would be benchmarked against. Same "evidence before extraction"
  bar as the Go / Kafka notes in `architecture-observations.md`.
- **Honouring a distinct `blockDuration`** (a block that outlives its window). No
  `@Throttle` sets one today; when a phase does, it adds `blocked_until` and one CASE
  branch. Named here so the simplification in §1 is a recorded decision, not a gap.
- **Per-hit / sliding-window fidelity.** The fixed window is deliberate (§1).
- **A scheduled sweep, `pg_cron`, or `@nestjs/schedule`.** The opportunistic sweep
  (Fork C) is the proportionate mechanism at this scale.
- **Per-user (not per-IP) keying for the authenticated password route.** Phase 8 §1
  already reasoned this through (the guard runs before `request.user` exists); unchanged.
- **The multi-instance deployment itself** — orchestration, load balancer config, a
  deploy pipeline, session affinity, health checks. This phase removes the throttle's
  blocker to running N instances; standing them up is separate work (Phase 15 §7's "no
  deploy pipeline" line still stands).
- **Throttle observability** — how often the limit trips, per-client or per-route
  metrics, alerting. Not asked for.
- **Revisiting the Phase 8 limits or adding per-route throttles** beyond the global
  backstop and the two auth routes. Unchanged from Phase 8 §7.
- **The other two named preconditions** in `architecture-observations.md` — the
  best-effort audit write (BR-082) and the unbounded `GET /categories` reference-cache
  read. This phase closes one; it does not touch those.
- **Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] `@nestjs/throttler` uses a `PostgresThrottlerStorage` backed by a `throttle_hits`
      table; the default in-memory `Map` store is no longer in the request path.
- [x] The store implements `ThrottlerStorage.increment` as one atomic
      `INSERT … ON CONFLICT DO UPDATE` — a fixed window that resets `hits` to 1 once
      `expires_at` has passed — with `isBlocked` computed as `hits > limit` and
      `blockDuration` treated as equal to `ttl`.
- [x] `throttle_hits` is added in one additive migration (no backfill), registered as a
      `ThrottleHit` entity in all three entity lists, and carries no audit columns.
- [x] An integration spec against real Postgres proves: the count climbs to `limit`
      un-blocked, `limit + 1` blocks, the window **resets on its own** after
      `expires_at`, and concurrent `increment`s do not lose an update.
- [x] An e2e test proves the limit is **shared across instances** — exhausting it
      through one `INestApplication` causes an immediate `429` from a second one on the
      same database.
- [x] `auth.e2e-spec.ts`'s rate-limiting block isolates tests by truncating
      `throttle_hits`, not by a fresh in-memory counter, and its comment says so; every
      e2e spec truncates `throttle_hits`; the full unit + integration + e2e suites pass.
- [x] Fork B (`UNLOGGED` vs `LOGGED`), Fork C (sweep strategy), and Fork E
      (`TRUST_PROXY`) are each decided and recorded — Fork E either shipped with its
      `.env.example` entry or written down as a known deployment-time requirement.
- [x] No new FR, BR, DTO, route, or role rule; `throttle_hits` appears in no response
      body; `frontend/` is untouched.
- [x] `architecture-observations.md` records the throttle-store precondition as
      **closed** (the first of its three to be), with the two deliberate divergences
      noted; `business-rules.md` (no-BR), `requirements.md` (no-FR), `api.md` (Phase 21,
      the cross-instance sentence), `README.md`, `product.md` §11, `domain-model.md`,
      and the authentication learning note all reflect this phase.
