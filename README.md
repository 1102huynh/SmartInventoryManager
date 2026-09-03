# Smart Inventory Manager

A small inventory tracking system for a small business — see `docs/product.md` for
the product vision and `docs/requirements.md` / `docs/business-rules.md` /
`docs/domain-model.md` for what it actually needs to do.

This is also a learning project: see `docs/learning-notes/` for NestJS concepts
explained against this project's real code.

## Project layout

```
docs/            Product, requirements, business rules, domain model, API docs, learning notes
tools/           Portable local PostgreSQL (see tools/README.md) — dev database
backend/         NestJS API (Phase 2)
frontend/        Static UI — index.html shell + styles.css + a graph of ES modules
                 (config/session/reference-data/ui/api/router/main + views/), served
                 by serve.js. No framework, no build step (Phase 13)
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

Open `http://localhost:5173`. **Running the frontend did not change in Phase 13** —
`serve.js` is byte-for-byte the same, it just serves several static files now instead
of one. No `npm install`, no build, no `node_modules` under `frontend/`.

## Tests

```
cd backend
npm test        # unit + integration (needs Postgres running)
npm run test:e2e  # end-to-end (needs Postgres running)
```

See `docs/learning-notes/testing-strategy.md` for what each of these actually proves.

## Current phase

Phase 13 — Frontend restructuring (`docs/phase-13-plan.md`): a **pure frontend
restructuring, no behaviour change, no new dependency**. `frontend/index.html` was a
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
