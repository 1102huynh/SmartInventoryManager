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

The API listens on `http://localhost:3000`.

**Signing in:** every route except `POST /auth/login` now requires a token (see
`docs/phase-3-plan.md`). Every seeded demo user (`npm run seed`) shares one dev-only
password:

| Email | Password | Role |
|---|---|---|
| `jordan@example.com` | `password123` | staff |
| `alex@example.com` | `password123` | owner |
| `sam@example.com` | `password123` | staff |

Only `alex@example.com` (Owner) can create/edit/deactivate/delete products,
suppliers, and categories (`docs/phase-5-plan.md`) — signing in as Jordan or Sam
(Staff) hides those actions in the UI, so seeing fewer buttons than Alex sees is
expected, not a bug. Both roles can record stock-in, stock-out, and adjustments.

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

Phase 5 — Role-based authorization (`docs/phase-5-plan.md`): the `role` field that's
been descriptive-only since Phase 2 is now enforced. Owner and Staff are the two
roles; Owner is required to create/edit/deactivate/delete Products, Suppliers, and
Categories, and every other authenticated action (stock-in, stock-out, adjustment,
every read) is open to both. FR-062 now Done.

Earlier phases: Phase 4 (`docs/phase-4-plan.md`) added Category CRUD, FR-005 Done.
Phase 3 (`docs/phase-3-plan.md`) added JWT authentication — real login, every write
behind a global guard, FR-060 Done. Phase 2 (`docs/backend-use-cases.md`) built the
NestJS backend + PostgreSQL wired to the Phase 1 UI; see its closing summary (in the
conversation, or ask for it to be re-derived) for architecture observations about what
might eventually move to Go/Kafka.
