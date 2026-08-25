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
frontend/        Static HTML/JS UI, talks to the backend over HTTP (Phase 2)
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
expected, not a bug. Both roles can record stock-in, stock-out, and adjustments.

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

Open `http://localhost:5173`.

## Tests

```
cd backend
npm test        # unit + integration (needs Postgres running)
npm run test:e2e  # end-to-end (needs Postgres running)
```

See `docs/learning-notes/testing-strategy.md` for what each of these actually proves.

## Current phase

Phase 9 — Audit log (`docs/phase-9-plan.md`): a single append-only `audit_events`
table now records who did what, and when — both halves the project had deferred by
name across four consecutive phases: every authentication attempt (login success,
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
