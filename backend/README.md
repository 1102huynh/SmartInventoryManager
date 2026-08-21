# Smart Inventory Manager — Backend

The NestJS + PostgreSQL API behind Smart Inventory Manager. See the root
[`README.md`](../README.md) for how this fits with the frontend and local
PostgreSQL setup, and `docs/` (in the repo root) for the product definition,
requirements, business rules, and domain model this API implements.

## What's here

A REST API covering products, categories, suppliers, inventory transactions
(stock-in / stock-out / adjustment), a read-only dashboard summary, and JWT-based
login — see `../docs/api.md` for the full endpoint reference and
`../docs/backend-use-cases.md` for how the modules fit together. Every write
endpoint requires a valid token (`docs/phase-3-plan.md`); there is no role-based
permission model yet (A-5 in `docs/product.md` stays deferred).

## Setup

Requires the local PostgreSQL in `../tools/` to be running (see
`../tools/README.md`) — this backend doesn't manage its own database.

```bash
npm install
cp .env.example .env      # only needed once — see .env.example for what each var does
npm run migration:run     # only needed once, or after a new migration is added
npm run seed               # only needed once, or to reset the demo data
npm run start:dev          # watch mode
```

The API listens on `http://localhost:3000` by default (`PORT` in `.env`).

**Signing in:** every route except `POST /auth/login` requires a bearer token. Every
seeded demo user (`npm run seed`) shares one dev-only password, `password123`
(`jordan@example.com`, `alex@example.com`, `sam@example.com`, and `riley@example.com`
— see `src/database/seeds/run-seed.ts`). Riley is seeded deactivated (Phase 6,
`docs/phase-6-plan.md`) and cannot actually sign in — that's intentional, to exercise
the Users screen's inactive state.

## Tests

This project uses three distinct kinds of test — see
`../docs/learning-notes/testing-strategy.md` for why each one exists and what it
proves that the others can't:

```bash
npm test          # unit + integration — needs Postgres running, uses smart_inventory_test
npm run test:e2e  # end-to-end, real HTTP — needs Postgres running, uses smart_inventory_e2e
npm run test:cov  # unit + integration, with coverage
```

Both `smart_inventory_test` and `smart_inventory_e2e` are separate databases from the
dev database (`smart_inventory`) — each test run truncates its tables, so tests never
touch or depend on seeded demo data. Run `npm run migration:run` with `DB_DATABASE`
pointed at each before the first run (see how `test/*.e2e-spec.ts` set
`process.env.DB_DATABASE` for the exact name).

## Other scripts

```bash
npm run build              # compile to dist/
npm run start:prod         # run the compiled build
npm run lint                # eslint --fix
npm run migration:generate  # generate a new migration from entity changes
npm run migration:revert    # roll back the last migration
```

## More context

- `../docs/api.md` — endpoint-by-endpoint reference.
- `../docs/business-rules.md` / `../docs/domain-model.md` — the rules and entities
  this API enforces and models.
- `../docs/learning-notes/` — NestJS concepts (DI, guards, transactions, DTOs, …)
  explained against this project's actual code, written while building it.
- `../docs/phase-3-plan.md`, `../docs/phase-4-plan.md` — the most recent phases'
  scoping and design decisions.
