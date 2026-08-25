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
| FR-021 | Record stock-out | User can record removal of a product: product, quantity, date, and optional reason. Decreases current stock; cannot exceed current stock. | Must | See BR-020–BR-022. Q-4: sale vs. generic removal |

## Inventory Management — Adjustment

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-022 | Record inventory adjustment | User can record a stock correction (increase or decrease) with a mandatory reason, used to reconcile actual counts with system records. | Must | See BR-030–BR-034 |

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
| FR-062 | Role-based authorization | A user is either Owner or Staff (BR-070). Creating, editing, deactivating, or deleting a Product, Supplier, or Category requires the Owner role; every read and every stock-in/out/adjustment is available to both roles. | Must | **Done** (Phase 5) — `RolesGuard` + `@Roles()`, enforced server-side; the frontend hides actions a Staff user can't perform. See BR-070–073 and `docs/phase-5-plan.md`. Roles are now assigned through account management — see FR-063. |
| FR-063 | Manage user accounts | An Owner can create a user account, edit its name/email/role, deactivate and reactivate it, and reset its password. | Should | **Done** (Phase 6) — `POST`/`PATCH /users/:id`/`PATCH /users/:id/status`/`PATCH /users/:id/password`, all Owner-only (BR-074). Not Must: `product.md` §7's MVP list doesn't include user administration, and the system is fully functional with seed-provisioned accounts — this closes an operability gap, not an MVP correctness gap. See `docs/phase-6-plan.md`. |
| FR-064 | Change own password | Any authenticated user can change their own password by supplying the current one. | Should | **Done** (Phase 6) — `PATCH /auth/password`. Same Should reasoning as FR-063: an operability improvement, not an MVP requirement. See `docs/phase-6-plan.md`. |
| FR-065 | View audit log | An Owner can view a log of authentication attempts and administrative changes — who did what, to what, and when. | Should | **Done** (Phase 9) — `GET /audit-events`, Owner-only (BR-084), `#/audit`. Same "operability, not MVP correctness" reasoning as FR-063/FR-064: an Owner opening this screen to answer a question is a capability with a route, a UI, and a person's job behind it — the honest inverse of Phase 7 and Phase 8's "no new FR," recorded as such in those phases' own sections below. See `docs/phase-9-plan.md`. |

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

## Cross-Reference Summary

```
FR-020 (stock-in)      → BR-010, BR-011, BR-012, BR-013 → Inventory Transaction / Supplier
FR-021 (stock-out)     → BR-020, BR-021, BR-022         → Inventory Transaction
FR-022 (adjustment)    → BR-030, BR-031, BR-032, BR-033, BR-034 → Inventory Transaction
FR-023/024 (current stock) → BR-040, BR-041, BR-042     → Product / Inventory Transaction
FR-030/031 (history)   → BR-050, BR-051                 → Inventory Transaction
FR-040/041/042 (low stock) → BR-060, BR-061              → Product
```
