# Smart Inventory Manager

A small inventory tracking system for a small business — see `docs/product.md` for
the product vision and `docs/requirements.md` / `docs/business-rules.md` /
`docs/domain-model.md` for what it actually needs to do.

This is also a learning project: see `docs/learning-notes/` for NestJS concepts (and,
since Phase 13, the frontend's ES-module architecture) explained against this project's
real code.

[![CI](https://github.com/1102huynh/SmartInventoryManager/actions/workflows/ci.yml/badge.svg)](https://github.com/1102huynh/SmartInventoryManager/actions/workflows/ci.yml)

## Project layout

```
docs/            Product, requirements, business rules, domain model, API docs, learning notes
tools/           Portable local PostgreSQL (see tools/README.md) — dev database
backend/         NestJS API (Phase 2)
frontend/        Static UI — index.html shell + styles.css + a graph of ES modules
                 (config/session/reference-data/ui/api/router/main + views/ + pager
                 + typeahead), served by serve.js. No framework, no build step
                 (Phase 13). A package.json + test/ was added in Phase 14 for
                 `npm test` only — the app itself still installs nothing.
```

## Running it locally

**1. Start PostgreSQL** (portable, no install — see `tools/README.md`):

```
pwsh tools/pg-start.ps1
```

**2. Start the backend:**

```
cd backend
npm install
cp .env.example .env      # only needed once
npm run migration:run     # only needed once, or after a new migration
npm run seed               # only needed once, or to reset demo data
npm run start:dev
```

The API listens on `http://localhost:3000`. It runs directly (no reverse proxy) in
this setup, so `req.ip` is honest — if this is ever deployed behind a load balancer
or reverse proxy, Express needs `app.set('trust proxy', ...)` first, or every request
will appear to come from the proxy's one address and Phase 8's rate limiting will
lock out the world. As of Phase 9, this is no longer only a throttling caveat: every
`login_failed`/`login_succeeded`/`account_locked` row in the audit log
(`docs/phase-9-plan.md`) also records this same address, so behind an unconfigured
proxy every one of those rows would silently record the proxy's own IP instead of
the real caller's — wrong data that *looks* like a real signal, not merely a weaker
rate limit.

**Signing in:** every route except `POST /auth/login` now requires a token (see
`docs/phase-3-plan.md`). Every seeded demo user (`npm run seed`) shares one dev-only
password:

| Email | Password | Role | Status |
|---|---|---|---|
| `jordan@example.com` | `password123` | staff | active |
| `alex@example.com` | `password123` | owner | active |
| `sam@example.com` | `password123` | staff | active |
| `riley@example.com` | `password123` | staff | **inactive — cannot sign in** |

Riley is seeded deactivated on purpose, to demonstrate the Users screen's inactive
state out of the box — signing in as Riley is expected to fail with "This account has
been deactivated," not a broken seed.

**Login is rate-limited and repeats-locked** (`docs/phase-8-plan.md`): five wrong
passwords in a row locks that account for fifteen minutes — that's the feature
working, not a broken seed, if you fat-finger `password123` a few times while
testing. The lock clears itself automatically, or an Owner can clear it immediately
by resetting that account's password from the Users screen. Requests are also capped
per address (a generous global limit, a tighter one on `/auth/login` and
`/auth/password`) — see `docs/api.md`'s `429` section if you ever see "Too many
requests" while developing.

Only `alex@example.com` (Owner) can create/edit/deactivate/delete products,
suppliers, and categories (`docs/phase-5-plan.md`) — signing in as Jordan or Sam
(Staff) hides those actions in the UI, so seeing fewer buttons than Alex sees is
expected, not a bug. Both roles can record stock-in and stock-out directly. **As of
Phase 12, signing in as Jordan or Sam and recording an adjustment produces "Sent for
approval," not a stock change — that is the feature, not a failed write.** The Owner
approves or rejects it at `#/approvals`; an Owner's own adjustment is still recorded
immediately.

**Managing accounts** (`docs/phase-6-plan.md`): an Owner manages every account —
create, edit, deactivate/reactivate, reset password — at `#/users`. Any signed-in
user can change their own password at `#/account`, reachable from the user chip.

**Audit log** (`docs/phase-9-plan.md`): an Owner can review who did what, and when —
every login attempt and every account/catalog change — at `#/audit`. It's **empty
right after `npm run seed`, and that's correct, not broken**: `npm run seed` writes
users, products, suppliers, categories, and transactions directly through
repositories, so it emits no audit events; the log is only ever as true as the
actions that produced it, and a seeded row would attribute an action to a person who
never performed it. Sign in, make a change, and the log will have something to show.

**3. Start the frontend:**

```
cd frontend
node serve.js
```

Open `http://localhost:5173`. **Running the frontend still needs nothing installed** —
`serve.js` is byte-for-byte the same and serves static files. Phase 14 added a
`frontend/package.json` and a `frontend/node_modules`, but those are **for the test
harness only** (`npm test` — see below); `node serve.js` uses neither, and there is
still no build step.

## Tests

```
cd backend
npm test        # unit + integration (needs Postgres running)
npm run test:e2e  # end-to-end (needs Postgres running)
```

```
cd frontend
npm install     # once — pulls jsdom, the only devDependency
npm test        # node --test: the paging logic (Phase 14, Fork G)
```

See `docs/learning-notes/testing-strategy.md` for what each of these actually proves.
The frontend suite is the first one it has — `pager.test.js` covers the pure pager
arithmetic, `products-list.test.js` (jsdom) covers the reset-to-page-1-on-filter
behaviour, (Phase 17) `typeahead.test.js` / `history-filter.test.js` (jsdom) cover
the search-as-you-type picker — debounce, the stale-response guard, select/clear, and
that the History filter re-requests by product id — and (Phase 18)
`stock-out-reason.test.js` (jsdom) covers the stock-out reason-category picker: the
fixed set of options, "Other" making the note required, and `reasonCategory` reaching
the request payload.

**The two test databases** (`smart_inventory_test` for integration, `smart_inventory_e2e`
for e2e) are separate from the dev `smart_inventory`, and the local setup for them was
previously unwritten. CI (below) creates them from scratch on every run; locally you do
it once. The portable Postgres in `tools/` is a stripped build with no `createdb`, so
use the helper script (it resolves its one dependency, `pg`, from `backend/`,
and runs from any directory):

```
node tools/create-test-databases.mjs
cd backend && DB_DATABASE=smart_inventory_e2e npm run migration:run
```

`smart_inventory_test` needs no migration — the integration specs build and drop their
own schema (`synchronize` + `dropSchema` in `src/database/test-data-source.ts`).
`smart_inventory_e2e` is migration-managed like the real app (`synchronize: false`), so
it needs `migration:run` once, and again after any new migration.

## Continuous integration

`.github/workflows/ci.yml` (Phase 15, `docs/phase-15-plan.md`) runs on every push and
every pull request against `develop`, plus a manual trigger. Four jobs (Phase 14 added
the last), each on a clean `postgres:17` service container where it needs a database:

- **`lint`** — `npm run lint:check` (`eslint`, no `--fix`) and `nest build` (the
  typecheck), both **blocking** as of Phase 16 (`docs/phase-16-plan.md`).
- **`test`** — creates `smart_inventory_test`, runs `npm test` (unit + integration).
- **`e2e`** — creates `smart_inventory_e2e`, runs the **whole migration chain from
  empty**, then `npm run test:e2e`. Nothing else exercises the migrations from scratch.
- **`frontend`** (Phase 14) — no database; `npm ci` then `npm test` (`node --test`)
  over the paging logic.

Line endings are normalised to LF by `.gitattributes` (Phase 16) so a lint run means
the same bytes on Windows and on the Linux runner.

It uses no secrets — every value is a throwaway dev default. **`lint`, `test` and `e2e`
are required checks on `develop`, and `develop` requires a pull request** (0 approvals —
the solo author self-merges, but nothing merges red). That's branch protection, a
repository setting rather than a file here (issue #6); `frontend` runs but is not
required, and admins are not forced through the gate. Node version is pinned by
`.nvmrc` (`24`) and `backend/package.json`'s `engines`, which `ci.yml` reads.
See `docs/learning-notes/ci-and-environments.md`.

## Current phase

Phase 22 — `audit_events` retention (`docs/phase-22-plan.md`, issue #12): `audit_events`
grew without bound — every login attempt, anonymous ones included, writes a row, and
Phase 9 capped only the *read* (`GET /audit-events`), deferring a policy for the *table*
to §7 with a concrete trigger ("a slow audit screen, or a backup size that surprises
someone"). That trigger is now met. Phase 22 bounds the table to a **rolling one-year
window**: rows older than a year are deleted by an **opportunistic probabilistic sweep**
on `AuditService.record()` (the 1-in-1000 mechanism Phase 21 gave `throttle_hits`) plus
one unconditional pass at startup — **no scheduler, no `@nestjs/schedule`, no new
dependency, no migration, no schema change** (the prune reuses Phase 9's `created_at`
index). The prune is best-effort, like the write it guards (BR-082): a failed `DELETE`
is logged and swallowed. Events past a year are permanently discarded — expected, not
data loss (BR-090). `BR-082` is amended (rows are no longer "never deleted") and
`BR-090` added; one "no new FR" note. Backend suite green (19 unit/integration suites,
7 e2e). See `docs/architecture-observations.md`'s Phase 22 section.

Earlier phases: Phase 21 — Shared throttle store (`docs/phase-21-plan.md`, issue #11):
`@nestjs/throttler` counted requests per client address in its default **in-memory
`Map`** — correct for one process, silently wrong for several (an N-instance deployment
would permit N× the configured rate, with no error). Phase 21 replaces it with a custom
`ThrottlerStorage` backed by a `throttle_hits` table in the **same Postgres** as account
lockout and everything else, so the limits still hold when the API is scaled out. One
atomic `INSERT … ON CONFLICT DO UPDATE` per throttled request, a fixed window (resets
once the window lapses), race-free by construction. **Run `npm run migration:run`** to
create the table. Also promotes Phase 8's "`trust proxy` is a deployment note" to a real
`TRUST_PROXY` setting (`backend/.env.example`) — behind a load balancer it **must** be
set, or every request looks like it comes from the balancer and the now-shared throttle
treats the whole world as one client. No new FR, no new BR, no `domain-model.md` entity;
one additive migration. See `docs/architecture-observations.md`'s Phase 21 section — the
first of that file's three named unenforced preconditions to be closed rather than
carried.

Earlier phases: Phase 20 — Remove the `mockFetch` / `?state=` mockup scaffolding (`docs/phase-20-plan.md`,
issue #10): deletes the last of Phase 1's navigable-mockup machinery — `UI.mockFetch`,
`UI.previewControl`, and the per-view `?state=` / `override` handling — that Phase 13 split
out **unchanged** and explicitly deferred removing (Phase 13 §7's own trigger, now met). Six
list screens (Dashboard, Products, Suppliers, Audit Log, Approvals, Inventory History) each
carried a dashed "Preview state" `<select>` — *Normal / Loading / Empty / Error* — that
shipped to production because the frontend has no build step to gate it. Each view's data
path is now plainly `Store.x().then(render).catch(errorState)`. **The real empty and error
panels are unchanged** — only the in-page way of faking them is gone; each screen now picks
its "nothing yet" vs. "no matches" copy from whether a filter is active. **Frontend only** —
no backend file, no `serve.js`, no route, **no migration**; a tenth "no new FR" note and a
ninth "no new BR" line. The existing `node --test` suite (28 tests) passes unedited. See
`docs/architecture-observations.md`'s Phase 20 section.

Earlier phases: Phase 19 — Dashboard stock counts in one query (`docs/phase-19-plan.md`, issue #9):
`DashboardService.getSummary` used to read the whole product catalogue with
`productsRepository.find()` and then make a **second** trip to sum every product's
transactions (`getCurrentStockMap`) before it could count the low / out-of-stock ones.
It now does both in **one** query — the grouped-subquery stock join Phase 14 introduced
for the Product List, extracted into a shared `joinCurrentStock` helper that
`ProductsService.findAll` also calls. The `GET /dashboard/summary` response is
**byte-for-byte identical** — same keys, same values — so the whole e2e suite passes
unedited; that is the proof nothing changed. **No migration** (unlike Phase 18), no
domain-document change: a ninth "no new FR" note, a "no new BR" line reaffirming
BR-040/042 ("current stock is `SUM(quantity_delta)`, never stored"). `serve.js`
unchanged; the frontend still needs no `npm install`. See
`docs/architecture-observations.md`'s Phase 19 section for why this join got extracted
rather than copied a third time, and the one invisible behaviour change (`needsAttention`
is now name-ordered).

Earlier phases: Phase 18 — Structured stock-out reason categories (`docs/phase-18-plan.md`):
resolves `product.md` Q-4, open since Phase 5. A stock-out can now carry an **optional**
reason category from a fixed set — `sale`, `internal_use`, `damaged`, `lost`, `expired`,
`return`, `other` — stored as a real `reason_category` enum column on
`inventory_transactions` (so it can be filtered and reported on, not just typed into a
note). `other` requires the free-text note. The stock-out wizard gets a picker; the
Inventory History and product-detail history screens show the category. **"Sale" is one
value in an enum** — no customer, no price (Q-1), no `Sale`/`Order` entity; a full one
stays Future. FR-021 is unchanged — a stock-out with no category is still valid, and
every pre-Phase-18 row and API caller keeps working (the column is nullable, no
default, **no backfill**). One new **FR-025** (Should) and one new **BR-023**;
`domain-model.md`, `api.md`, and `product.md` §10 (Q-4 now Resolved) all updated.
**There is a migration in Phase 18** (`1787930000000-AddStockOutReasonCategory`), unlike
Phases 14–17 and 19 — run `npm run migration:run` after pulling. See
`docs/architecture-observations.md`'s Phase 18 section for the additive-nullable-enum
pattern and the three-registries `@Check`.

Earlier phases: Phase 17 — Searchable / typeahead pickers (`docs/phase-17-plan.md`):
finishes the job Phase 14 §7 named. The stock-in wizard's supplier `<select>` and the
Inventory History product-filter `<select>` are now **search-as-you-type** controls
(`frontend/typeahead.js`, a shared module) that query `GET /suppliers?search=&status=active`
and `GET /products?search=` a page at a time; the Categories screen's client-side
product count is a server-side `productCount` on the paged `GET /categories` read. No
migration, no domain document change — a field you type into to filter its options is a
screen affordance.

Earlier phases: Phase 16 — A clean, blocking lint (`docs/phase-16-plan.md`): the `lint` job Phase 15
wired was `continue-on-error` — it reported, it did not gate. This phase gets `eslint`
to exit `0` on the backend tree (an `eslint --fix` sweep for the 24 auto-fixable
errors, committed alone as `style:`; one rule — `no-unsafe-call` — relaxed in the
existing test-file override for supertest response bodies; two dead vars removed), adds
a `--fix`-free `lint:check` script for CI, adds `.gitattributes` so a lint run is
byte-identical on Windows and Linux, and removes `continue-on-error` so the eslint step
now **blocks**. No application behaviour, no migration, no domain document changed; the
full backend suite is unchanged (14/143, 7/90). Branch protection is now a one-click
follow-on, still deferred until a second contributor (`docs/phase-16-plan.md` §7).

Earlier phases: Phase 15 — Continuous integration (`docs/phase-15-plan.md`): a CI pipeline
(`.github/workflows/ci.yml`) that runs lint, the unit + integration suite, and the e2e
suite against a clean `postgres:17` on every push and pull request. **No application
code, no test, no migration changed** — it runs the suite that already existed. It also
made explicit a set of things "the suite is green" had silently assumed: the two test
databases (`smart_inventory_test`, `smart_inventory_e2e`) and their setup are now
written down (see "Continuous integration" above and `tools/create-test-databases.mjs`),
and the `e2e` job is the first thing that runs the whole migration chain against an
empty database. A Node version is pinned (`.nvmrc` = `24`, `backend/package.json`
`engines`) so local and CI agree. No new FR, BR, entity, route, or domain document
change. See `docs/architecture-observations.md`'s Phase 15 section for the preconditions
it named (including a pre-existing lint-cleanliness gap it surfaced) and what it
deliberately left out (a deploy pipeline; branch protection came later in issue #6,
now that `lint`/`test`/`e2e` are required checks on `develop`).

Earlier phases: Phase 14 — Catalogue paging (`docs/phase-14-plan.md`): the four catalogue list screens
(`/products`, `/suppliers`, `/categories`, `/users`) get a real paging design — a page,
a page size, a total, and Prev/Next on the screen. The routes gain an **optional**
`?page=&pageSize=`: supplied, the response is `{ items, page, pageSize, total }`;
omitted, it is the bare array exactly as before — the shape the stock/adjustment wizard
pickers and the `CATEGORIES` reference cache still rely on, so those are untouched.
`ProductsService.findAll` is rewritten to compute current stock in SQL, so
`?status=low`/`out` is a real `WHERE` clause and pages the low-stock set instead of
taking 50 products by name and then filtering. **The Product List showing 50 rows with
Prev/Next is the feature, not a truncated query** — the total is on the pager and the
other pages are one click away. The frontend gets its first automated test
(`frontend/package.json`, `frontend/test/`, `npm test` → `node --test`); `serve.js` is
still **byte-for-byte unchanged** and running the app still needs no `npm install`.
**No migration this phase** (unlike Phases 11 and 12) — it is a query rewrite plus
additive query params, so there is no `migration:run` step after pulling it. No new FR,
BR, entity, route, or domain document change. See `docs/architecture-observations.md`'s
Phase 14 section for the unbounded-catalogue-reads precondition it *partly* retires (the
pickers still fetch every row), the offset-over-keyset call, and the envelope/header
asymmetry. *(Numbered before Phase 15 but implemented after it — CI shipped first.)*

Earlier phases: Phase 13 — Frontend restructuring (`docs/phase-13-plan.md`): a **pure
frontend restructuring, no behaviour change, no new dependency**. `frontend/index.html` was a
3,061-line single file — a 284-line `<style>` block and one `<script>` holding the
config layer, the API client, the render helpers, the router, and sixteen views. It
is now a ~14-line shell that links `styles.css` and loads
`<script type="module" src="main.js">`, plus a graph of small ES modules
(`config`, `session`, `reference-data`, `ui`, `api`, `router`, `main`, and nine
`views/*.js` grouped by resource, mirroring the backend modules). Native ES modules
only — no framework, no bundler, no build step, no `node_modules`. `serve.js` is
**byte-for-byte unchanged** and serves the module graph as-is. Shared in-memory state
(`CURRENT_USER`/`ACCESS_TOKEN`/`CATEGORIES`) moved into `session.js` /
`reference-data.js` behind accessor functions, since an imported binding can't be
reassigned across modules. No domain document changed — no new FR, BR, entity, route,
or response. See `docs/architecture-observations.md` for the two decisions a future
reader will re-litigate (native modules over a bundler, on `serve.js`'s own grounds;
decomposing the frontend by the same resources as the backend).

Earlier phases: Phase 12 — Adjustment approval (`docs/phase-12-plan.md`): resolves `product.md` Q-6,
open by name since Phase 5. A **Staff-initiated** adjustment is now a *request* an Owner
approves or rejects at `#/approvals` before it changes stock; an **Owner-initiated**
adjustment is recorded immediately, exactly as before. `POST /products/:id/adjustments`
returns `201` + a transaction for an Owner, `202` + a request for Staff. Two new routes
(`GET /adjustment-requests`, `PATCH /adjustment-requests/:id/status`) and a new
`AdjustmentsModule` that depends on `InventoryModule`, never the reverse — the extra
capability sits *beside* the concurrency-sensitive core, not inside it, so the Phase 2
extraction seam holds. `inventory_transactions` gains no column, constraint, or index;
the delta is computed at approval under the same row lock the immediate path uses, and
the approved transaction is attributed to the **requester**, not the approver. The new
list read ships bounded on arrival with Phase 11's exact convention.

**After pulling this, run `npm run migration:run` against `smart_inventory` *and*
against `smart_inventory_e2e`** (set `DB_DATABASE=smart_inventory_e2e` first). This
phase ships one additive migration — `CREATE TABLE adjustment_requests` plus its enum
and two indexes; `down()` drops them and loses nothing. The e2e database is the one
that's easy to forget, and forgetting it doesn't look like a broken migration — the
e2e suite just runs against a stale schema and fails in a confusing place.

Earlier phases: Phase 11 — Bounded reads (`docs/phase-11-plan.md`): the two transaction
log reads — `GET /inventory-transactions` and `GET /products/:id/transactions` — now
accept a `limit` (default 100, max 500) and return at most that many rows, newest-first
(`occurred_at DESC, id DESC`), the same cap `/audit-events` has carried since Phase 9.
When more rows matched than were returned, the response carries
`X-Result-Truncated: true`; `/audit-events` gets that header retroactively, since it
had been truncating silently. The dashboard no longer materialises the whole
transaction table to show eight rows and one count. The four catalogue reads
(`/products`, `/suppliers`, `/categories`, `/users`) are deliberately left uncapped —
a truncated catalogue is a wrong answer where a truncated log is a reading position;
paging them is a deferred product decision (`docs/phase-11-plan.md` §7).

**The history screen showing "the most recent 100 movements" is the feature, not a
broken query** — `?days=` or a product filter is how to see past it, and the screen
says so with a line above the table when it truncated. Four screens show that line:
Inventory History, Product Detail's history panel, Supplier Detail's "received from"
panel, and the Audit Log.

**One cross-origin detail that would fail silently if it is ever undone.** That line is
driven by the `X-Result-Truncated` response header, and the frontend runs on its own
origin (`:5173`) from the API (`:3000`). A browser lets page JavaScript read only a
short safelist of response headers unless the server names the rest in
`Access-Control-Expose-Headers` — which is why `app.enableCors()` in
`backend/src/main.ts` is called with `CORS_OPTIONS`
(`backend/src/common/cors-options.ts`) rather than with no arguments. Drop that list
and nothing errors: the API still sends the header, `curl` still shows it, the whole
backend suite still passes, and the notice simply never appears again while the screens
keep truncating. `app.e2e-spec.ts` asserts the server half (the response really does
carry `Access-Control-Expose-Headers`); the browser half is checked by loading the app
against a database with more than 100 transactions and looking for the line.

Phase 11 also shipped one additive migration — a `CREATE INDEX` on
`inventory_transactions (occurred_at DESC, id DESC)` — with the same
run-against-both-databases caveat the Phase 12 note above repeats: the e2e database is
the one that's easy to forget, and forgetting it doesn't look like a broken migration.

Earlier phases: Phase 10 — Schema-wide `timestamptz` (`docs/phase-10-plan.md`): all
eleven plain `TIMESTAMP` columns across six tables (`products`, `suppliers`, `users`,
`categories`, `inventory_transactions.created_at`, `audit_events.created_at`, plus
`users.locked_until`) are now `timestamptz`, converted in one migration. This closes a
question parked by name in three consecutive phases (Phase 7 §7, Phase 8 §1, Phase 9
§1): a plain `TIMESTAMP` stores a clock reading, not an instant, and it does not record
which clock. Every writer here — Postgres's `DEFAULT now()` and TypeORM's
`@CreateDateColumn`/`@UpdateDateColumn` alike — produces digits in Postgres's session
zone, while every read reinterprets those digits in Node's zone. The writers agree with
each other; the writer and the reader only ever agreed because both processes run on one
machine today. **No route's response changes** — every timestamp
string the API returns is byte-for-byte what it was before this phase; what changes is
that it now survives Node and Postgres disagreeing about a zone, which it would not
have before. See `docs/architecture-observations.md`'s resolved entry for the full
argument.

Earlier phases: Phase 9 — Audit log (`docs/phase-9-plan.md`) added a single
append-only `audit_events` table that records who did what, and when — both halves
the project had deferred by name across four consecutive phases: every authentication
attempt (login success,
login failure, account lockout) and every administrative write (account
create/edit/status/password-reset, product/supplier/category create/edit/status/
delete). The **actor** (who performed it) and **subject** (the account it's about)
are recorded as two distinct, often-different facts — a failed login has a subject
and no actor, because the person who typed the wrong password is precisely not the
account holder. Recording is best-effort (a failed audit write never fails the
operation it describes — this is a *record*, not a *proof*) and deliberately excludes
stock movements (`inventory_transactions` already owns those, BR-083) and reads. An
Owner reviews it at `#/audit`, Owner-only, with a cross-link from every account on
the Users screen — most usefully the `locked` badge Phase 8 shipped, which now leads
somewhere. FR-065 (Should) added. See `business-rules.md` BR-082–084 and
`docs/learning-notes/cross-cutting-concerns.md` for why this is an explicit service
call rather than a global interceptor or an ORM entity subscriber.

Earlier phases: Phase 8 (`docs/phase-8-plan.md`) made repeated failed logins
expensive — a global request throttle sits in front of every route (generous
defaults), with a much tighter limit on `POST /auth/login` and `PATCH
/auth/password`; five consecutive failed logins temporarily lock that account for
fifteen minutes, self-clearing, no Owner action required (though an Owner's password
reset also clears it immediately). Neither mechanism reveals whether an account
exists to an unauthenticated caller — a locked or deactivated account's specific
message is only reachable with the *correct* password. No new FR; this hardened
FR-060, it didn't extend it. See `business-rules.md` BR-079–081 and
`docs/learning-notes/authentication-and-guards.md` for the "rate limiting vs.
lockout" distinction. Phase 7 (`docs/phase-7-plan.md`) gave `users` and `categories`
`created_at`/`updated_at`, closing the last gap in a convention `products` and
`suppliers` have had since day one — `inventory_transactions` deliberately keeps
`created_at` only (BR-051's immutability). Phase 6 (`docs/phase-6-plan.md`) made
users a managed resource — an Owner can create, edit, deactivate/reactivate, and
reset the password of any account through the UI, no more `psql` required; every
user can change their own password. FR-063 and FR-064 Done. Phase 5
(`docs/phase-5-plan.md`) enforced the `role` field — Owner and
Staff, Owner required for Product/Supplier/Category writes, every other authenticated
action open to both. FR-062 Done. Phase 4 (`docs/phase-4-plan.md`) added Category
CRUD, FR-005 Done. Phase 3 (`docs/phase-3-plan.md`) added JWT authentication — real
login, every write behind a global guard, FR-060 Done. Phase 2
(`docs/backend-use-cases.md`) built the NestJS backend + PostgreSQL wired to the
Phase 1 UI; see its closing summary (in the conversation, or ask for it to be
re-derived) for architecture observations about what might eventually move to
Go/Kafka.
