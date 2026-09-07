# Functional Requirements — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-20

Priority legend: **Must** (MVP), **Should** (near-term, non-blocking), **Future** (postponed).
See `product.md` for scope rationale and `business-rules.md` for the rules each requirement
must satisfy.

## Product Management

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-001 | Create product | User can create a product with a name, unique identifier (SKU), and unit of measurement. | Must | See BR-001, BR-003. **Owner only** (Phase 5, FR-062). |
| FR-002 | Edit product | User can edit a product's editable details (name, threshold, category, etc.). SKU identity should not be freely changeable once transactions exist. | Must | See BR-001. **Owner only** (Phase 5, FR-062). |
| FR-003 | Activate / deactivate product | User can mark a product Active or Inactive. Inactive products are excluded from new stock-in/out transactions. | Must | See BR-002. **Owner only** (Phase 5, FR-062). |
| FR-004 | View product list & detail | User can view all products with current stock and status, and drill into a single product's detail. | Must | Detail view links to FR-030 (history) |
| FR-005 | Categorize product | User can optionally assign a product to a category for organization/filtering. | Should | **Done** (Phase 4) — full Category CRUD (`POST`/`PATCH`/`DELETE /categories`). Q-5 resolved: flat, no hierarchy — see `docs/phase-4-plan.md` §1. **Owner only** (Phase 5, FR-062). |
| FR-006 | Prevent product deletion with history | Products that have transaction history cannot be hard-deleted, only deactivated. | Must | See BR-004. **Owner only** (Phase 5, FR-062). |

## Supplier Management

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-010 | Create supplier | User can create a supplier with a name and contact information. | Should | **Owner only** (Phase 5, FR-062). |
| FR-011 | Edit supplier | User can edit supplier details. | Should | **Owner only** (Phase 5, FR-062). |
| FR-012 | View supplier list & detail | User can view all suppliers and see stock-in history associated with a supplier. | Should | |
| FR-013 | Activate / deactivate supplier | User can mark a supplier Active or Inactive; inactive suppliers cannot be selected for new stock-in. | Should | Mirrors FR-003. **Owner only** (Phase 5, FR-062). |

## Inventory Management — Stock In

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-020 | Record stock-in | User can record receipt of a product: product, quantity, date, and (if supplier tracking is enabled) supplier. Increases current stock. | Must | See BR-010–BR-013. Q-2: supplier optional/mandatory |

## Inventory Management — Stock Out

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-021 | Record stock-out | User can record removal of a product: product, quantity, date, and optional reason. Decreases current stock; cannot exceed current stock. | Must | See BR-020–BR-022. Q-4 resolved (Phase 18): the category is optional, see FR-025 |
| FR-025 | Categorise a stock-out | User may optionally tag a stock-out with a reason category from a fixed set (`sale`, `internal_use`, `damaged`, `lost`, `expired`, `return`, `other`); `other` requires a free-text note. | Should | **Done** (Phase 18) — `reasonCategory?` on `POST /products/:id/stock-out`. See BR-023. Resolves `product.md` Q-4 in its lighter form (no `Sale`/`Order` entity). Numbered after the current-stock FRs, which predate it; kept in the Stock Out section by topic. |

## Inventory Management — Adjustment

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-022 | Record inventory adjustment | User can record a stock correction (increase or decrease) with a mandatory reason, used to reconcile actual counts with system records. | Must | See BR-030–BR-034. **Phase 12**: a Staff-initiated adjustment is a *request* an Owner must approve before it changes stock (an Owner's own adjustment is still immediate) — see FR-066 and BR-085. |

## Current Stock

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-023 | View current stock | User can see the current stock quantity for any product. | Must | See BR-040–BR-042 |
| FR-024 | Derive current stock from transactions | Current stock is always computed from (or kept consistent with) the full transaction history — it is never edited directly. | Must | See BR-040 |

## Inventory History

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-030 | View product transaction history | User can view the chronological list of all stock-in, stock-out, and adjustment transactions for a given product. | Must | See BR-050, BR-051 |
| FR-031 | View global transaction log | User can view all inventory transactions across all products, e.g. for a recent-activity view. | Should | Feeds dashboard (FR-050) |

## Low Stock

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-040 | Configure low-stock threshold | User can set a low-stock threshold per product. | Must | Q-3: per-product vs. global default |
| FR-041 | Detect low-stock products | System flags a product as low-stock when current stock falls at or below its threshold. | Must | See BR-060, BR-061 |
| FR-042 | View low-stock list | User can view the list of all products currently flagged as low-stock. | Must | Feeds dashboard (FR-050) |

## Dashboard

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-050 | Dashboard summary | User sees a summary view on entry: total active products, count of low-stock products, and recent transaction activity. | Should | Composed from FR-004, FR-031, FR-042; no new data of its own |

## User Attribution & Accounts

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-060 | User login | A user must authenticate to use the system. | Must | **Done** (Phase 3) — JWT login (`POST /auth/login`), every write behind a global guard. RBAC done in Phase 5 — see FR-062. Login is rate-limited and repeated failures temporarily lock an account (Phase 8, BR-079–081) — see the note below; this hardens FR-060, it doesn't extend it. |
| FR-061 | Attribute transactions to user | Every stock-in, stock-out, and adjustment records which user performed it. | Must | Supports auditability, BR-050 |
| FR-062 | Role-based authorization | A user is either Owner or Staff (BR-070). Creating, editing, deactivating, or deleting a Product, Supplier, or Category requires the Owner role; every read and every stock-in/out/adjustment is available to both roles. | Must | **Done** (Phase 5) — `RolesGuard` + `@Roles()`, enforced server-side; the frontend hides actions a Staff user can't perform. See BR-070–073 and `docs/phase-5-plan.md`. Roles are now assigned through account management — see FR-063. **Phase 12**: role now gates an *outcome*, not only a route — a Staff-initiated adjustment still reaches the same route but produces a pending request rather than a transaction (BR-072 amended), and the approve/reject/withdraw gate on `PATCH /adjustment-requests/:id/status` depends on the actor's relationship to the row, so it is enforced in the service rather than by `@Roles()` alone. |
| FR-063 | Manage user accounts | An Owner can create a user account, edit its name/email/role, deactivate and reactivate it, and reset its password. | Should | **Done** (Phase 6) — `POST`/`PATCH /users/:id`/`PATCH /users/:id/status`/`PATCH /users/:id/password`, all Owner-only (BR-074). Not Must: `product.md` §7's MVP list doesn't include user administration, and the system is fully functional with seed-provisioned accounts — this closes an operability gap, not an MVP correctness gap. See `docs/phase-6-plan.md`. |
| FR-064 | Change own password | Any authenticated user can change their own password by supplying the current one. | Should | **Done** (Phase 6) — `PATCH /auth/password`. Same Should reasoning as FR-063: an operability improvement, not an MVP requirement. See `docs/phase-6-plan.md`. |
| FR-065 | View audit log | An Owner can view a log of authentication attempts and administrative changes — who did what, to what, and when. | Should | **Done** (Phase 9) — `GET /audit-events`, Owner-only (BR-084), `#/audit`. Same "operability, not MVP correctness" reasoning as FR-063/FR-064: an Owner opening this screen to answer a question is a capability with a route, a UI, and a person's job behind it — the honest inverse of Phase 7 and Phase 8's "no new FR," recorded as such in those phases' own sections below. See `docs/phase-9-plan.md`. |
| FR-066 | Submit, approve, or reject a stock adjustment | Any authenticated user can submit an adjustment. A Staff-initiated one becomes a pending request that an Owner approves or rejects before it changes stock; the requester may withdraw their own pending request. An Owner-initiated adjustment is recorded immediately. | Should | **Done** (Phase 12) — `POST /products/:id/adjustments` (201+transaction for Owner, 202+request for Staff), `GET /adjustment-requests`, `PATCH /adjustment-requests/:id/status`; `#/approvals`. Same "operability, not MVP correctness" reasoning as FR-063/064/065 — `product.md` §7's MVP list does not contain it and the system is fully functional without it. Unlike those three, this FR *changes an existing rule's behaviour* (BR-072, amended) rather than adding beside it. Resolves `product.md` Q-6. See `docs/phase-12-plan.md`, BR-085–089. |

## Audit Timestamps (Phase 7 — no new FR)

Phase 7 (`docs/phase-7-plan.md`) gave `users` and `categories` the same
`created_at`/`updated_at` pair `products` and `suppliers` already had, and documented
the convention (`domain-model.md` §8). This is a data-model consistency change, not a
new capability — "when was this row written" is not a user goal in `product.md` §4 —
so no FR is added for it. The capability it *enables* (showing "Added on" / "Last
updated" on a detail view, which the frontend now does for products, suppliers, and
users) is noted here as available to future work, not tracked as its own requirement.

## Authentication Hardening (Phase 8 — no new FR)

Phase 8 (`docs/phase-8-plan.md`) added a per-address request throttle and a
temporary, self-clearing account lock after repeated failed logins. Like Phase 7's
audit timestamps, this adds no new FR: nobody's job is "resist password guessing,"
and `product.md` §4 names no such user goal. The capability is that logging in keeps
working for a legitimate user while attacking it stops working — a security
hardening of FR-060, not a new requirement. The rules themselves live in
`business-rules.md` as BR-079–081, the same place BR-074–078 recorded Phase 6's
authentication and account rules.

## Schema-Wide `timestamptz` (Phase 10 — no new FR)

Phase 10 (`docs/phase-10-plan.md`) converted all eleven plain `TIMESTAMP` columns
across six tables to `timestamptz`, in one migration. Like Phase 7's audit timestamps
and Phase 8's authentication hardening, this adds no new FR: "what type a server
timestamp is stored as" is not a user goal in `product.md` §4, and no Owner opens a
screen to do anything with it. Unlike either of those phases, it also changes no
value any route returns — a timestamp captured from a response before the migration
is byte-identical after it (`docs/phase-10-plan.md` §1 "What this phase buys is not a
value — it is a guarantee"). Keeping this note beside Phase 7's and Phase 8's, rather
than folding it into one of them, is what makes the contrast with Phase 9's FR-065
legible as a record of judgement rather than a list.

## Bounded Reads (Phase 11 — no new FR)

Phase 11 (`docs/phase-11-plan.md`) capped the two transaction log reads
(`GET /inventory-transactions`, `GET /products/:id/transactions`) at a `limit` (default
100), matching the cap `/audit-events` has had since Phase 9. Like Phases 7, 8, and 10,
this adds no new FR: "how many rows one request returns" is not a user goal in
`product.md` §4, and no Owner opens a screen to do anything with it.

**FR-030 and FR-031 use the word "all" — "the chronological list of *all* … transactions
for a given product" (FR-030), "view *all* inventory transactions" (FR-031) — and the
honest reading is that "all" names the screen's *subject*, not a transport-level
guarantee about one HTTP response.** A history screen that shows the recent movements
and lets a user narrow the range with filters still lets them "view the chronological
list of all transactions"; a request that carries 100 of them does not stop that being
true. The requirement is satisfied by a screen that shows the history — it was never a
promise that a single response would carry every row of it. Recorded here as an
interpretation with its reasoning, in the same spirit as Phase 9's FR-065 note
recording why *that* phase did add an FR: this is the one place a reader could
reasonably think Phase 11 broke a Must, and it did not.

## Adjustment Approval (Phase 12 — new FR-066)

Phase 12 (`docs/phase-12-plan.md`) is the fourth phase in the FR-063/064/065 line to
add a Should FR for an operability capability rather than an MVP-correctness one — an
Owner (or Staff member) opening a screen to do a job, with a route and a person behind
it. It is recorded here as its own note, the way FR-065's reasoning was, because it is
also the one place a reader could think the phase quietly contradicted a Must:
**FR-022 is still Must and still reads "user can record an adjustment," and it still can
— the phase changes what a Staff submission *produces* (a pending request instead of an
immediate transaction), not whether it is allowed.** BR-072 is amended in place with
its date to say so, rather than left for a reader to reconcile two rules that disagree.
This resolves `product.md` Q-6, open by name since Phase 5.

## Continuous Integration (Phase 15 — no new FR)

Phase 15 (`docs/phase-15-plan.md`) added a CI pipeline (`.github/workflows/ci.yml`)
that runs lint, the unit + integration suite, and the e2e suite against a clean
Postgres on every push and pull request. Like Phases 7, 8, 10, and 11, this adds no
new FR — the fifth such note: a build-and-test pipeline is an engineering practice,
not a capability in `product.md` §4, and no user opens a screen to interact with it.
Unlike those four, it also touches **no application code, no migration, and no test** —
it runs the suite that already exists. The only files that changed are `.github/`,
`.nvmrc`, `backend/package.json`'s new `engines` field, `tools/create-test-databases.mjs`,
and documentation.

## Catalogue Paging (Phase 14 — no new FR)

Phase 14 (`docs/phase-14-plan.md`) gave the four catalogue list screens
(`/products`, `/suppliers`, `/categories`, `/users`) a real paging design — a page, a
page size, a total, and Prev/Next on the screen — and moved the Product List's
low/out-of-stock filter into SQL. Like Phases 7, 8, 10, 11, and 15, this adds no new
FR — the sixth such note, and the closest kin of Phase 11's: paging is transport plus
a small screen affordance ("Page 3 of 12 · 573 products" with a Prev/Next control), not
a user goal in `product.md` §4, and no Owner opens a screen to interact with "which
50 rows".

**FR-004 uses the word "all" — "view *all* products with current stock and status" —
and, exactly as with FR-030/031's "all" in Phase 11's note above, the honest reading
is that "all" names the *screen's subject*, not one HTTP response's payload.** A
Product List that shows 50 rows with a total and a Prev/Next still lets a user view the
list of all products — it was never a promise that a single response carries every row.
Recorded here with its reasoning, the one place a reader could think Phase 14 broke a
Must. (Numbered before Phase 15 but landed after it — the CI pipeline was built first.)

## A Clean, Blocking Lint (Phase 16 — no new FR)

Phase 16 (`docs/phase-16-plan.md`) got `eslint` to exit `0` on the backend tree and
made the CI `lint` step blocking. The seventh "no new FR" note: a lint gate is an
engineering practice, not a `product.md` §4 capability. The `src/`/`test/` edits are a
mechanical `eslint --fix` sweep (formatting), one rule (`no-unsafe-call`) relaxed in
the existing test-file override, and two dead variables removed — proven behaviour-inert
by the full suite passing unchanged (14/143, 7/90). No migration, no domain-model
change.

## Searchable / Typeahead Pickers (Phase 17 — no new FR)

Phase 17 (`docs/phase-17-plan.md`) turned the stock-in wizard's supplier `<select>`
and the Inventory History product-filter `<select>` into search-as-you-type controls
over the paged, searchable routes Phase 14 added, and replaced the Categories screen's
client-side product count with a server-side one. The eighth "no new FR" note, and the
close kin of Phases 11 and 14's: **FR-004 ("view all products…"), FR-020 ("record
stock-in: product, quantity, date, and… supplier"), and FR-031 ("view all inventory
transactions") all read exactly as before.** A field where you type to filter the
options, instead of scrolling a list of all of them, is a screen affordance over the
same capability — no user goal in `product.md` §4 is added, changed, or removed, and no
Owner opens a screen to interact with "how the supplier field is populated". This is
what finishes the job Phase 14 §7 named — the pickers no longer fetch the whole
catalogue — but the requirement it serves (FR-020's supplier selection) is untouched.

## Stock-Out Reason Categories (Phase 18 — FR-025, a Should)

Phase 18 (`docs/phase-18-plan.md`) resolves `product.md` Q-4 in its lighter form: a
stock-out may carry an optional structured reason from a fixed seven-value set, stored
as a real `reason_category` enum column on `inventory_transactions` (migration
`1787930000000`). This is a genuine new capability with a route parameter, a UI
picker, and a rule (BR-023) — the honest inverse of Phases 14–17's "no new FR" notes,
recorded here the way FR-065 (Phase 9) and FR-066 (Phase 12) were: **FR-021 is
unchanged** and still reads "…and optional reason" — a stock-out with no category is
still valid, and every pre-Phase-18 row and API caller keeps working (the column is
nullable, no default, no backfill). What is new is FR-025: the *option* to say which
kind of stock-out it was. It adds no `Sale`/`Order` entity — "sale" is one value in an
enum, with no customer and no price (Q-1). A full Sale entity stays Future
(`product.md` §7).

## Cross-Reference Summary

```
FR-020 (stock-in)      → BR-010, BR-011, BR-012, BR-013 → Inventory Transaction / Supplier
FR-021 (stock-out)     → BR-020, BR-021, BR-022         → Inventory Transaction
FR-025 (stock-out reason category) → BR-023             → Inventory Transaction
FR-022 (adjustment)    → BR-030–BR-034; BR-072 (amended), BR-085–089 → Inventory Transaction / Adjustment Request
FR-066 (adjustment approval) → BR-072 (amended), BR-085, BR-086, BR-087, BR-088, BR-089 → Adjustment Request
FR-023/024 (current stock) → BR-040, BR-041, BR-042     → Product / Inventory Transaction
FR-030/031 (history)   → BR-050, BR-051                 → Inventory Transaction
FR-040/041/042 (low stock) → BR-060, BR-061              → Product
```
