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
| `jordan@example.com` | `password123` | Staff |
| `alex@example.com` | `password123` | Owner |
| `sam@example.com` | `password123` | Staff |

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

Phase 3 — JWT authentication (`docs/phase-3-plan.md`): real login, every write behind a
global guard, FR-060 now Done. Phase 2 (`docs/backend-use-cases.md`) built the NestJS
backend + PostgreSQL wired to the Phase 1 UI; see its closing summary (in the
conversation, or ask for it to be re-derived) for architecture observations about what
might eventually move to Go/Kafka.
