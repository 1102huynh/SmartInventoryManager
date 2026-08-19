# Backend Use Cases — Phase 2

Status: Phase 2 — NestJS Backend
Last updated: 2026-08-19

This is the output of Step 1 (re-analysis) and Step 2 (use case derivation) before any
backend code was written. It maps the UI mockup's workflows and the documented MVP
(`requirements.md`, `business-rules.md`, `domain-model.md`) onto the concrete backend
operations this phase implements.

## Re-analysis notes

- The UI mockup (Phase 1) is the reference for exact fields, since it's already a
  faithful reading of the requirements. Field names below match what the mockup's
  forms actually collect.
- **FR-060 (login) is still not implemented.** The UI mockup simulates a signed-in
  session with no login screen (see `docs/ui-open-questions.md` Q-UI-4). This phase
  carries that same decision into the backend: there is a `users` table and every
  transaction is attributed to a user (FR-061), but there is no authentication —
  the "current user" is passed by the client and trusted as-is. **This is a known,
  deliberate gap**, not an oversight — see "Deferred: Authentication" below.
- No new inconsistencies between the UI and the documents were found beyond what
  `docs/ui-open-questions.md` already captured in Phase 1. Those decisions (adjustment
  entered as a new counted quantity, adjustment allowed on inactive products, the
  reason-category taxonomy, low-stock as a filter rather than a screen, suppliers
  keeping historical references after deactivation) all carry forward unchanged into
  the backend's behavior.

## Deferred: Authentication

FR-060 is a Must-have, but building real authentication (password hashing, login
endpoint, sessions/JWT, Guards) is a substantial feature in its own right and the UI
doesn't have a login flow to exercise it yet. Rather than bolt on fake auth that
nothing uses, this phase implements **attribution without authentication**: a small
`users` table (seeded, mirrors the UI mockup's three demo users), and every
write endpoint accepts an `x-user-id` header identifying who's performing the action
— trusted as-is, not verified against a password or session. This keeps FR-061
(attribution) working end-to-end while honestly leaving FR-060 (login) for a later
phase, when Guards become the right tool for the job.

---

## Use Cases

### Category

| Use Case | Purpose | Input | Result | Rules |
|---|---|---|---|---|
| List Categories | Populate the category filter/select in Product screens | — | All categories | — (reference data, FR-005) |

Categories are seeded reference data (Should-have, FR-005) — the UI never creates one,
so there's no Create/Update/Delete use case for them yet.

### Supplier

| Use Case | Purpose | Input | Result | Rules |
|---|---|---|---|---|
| Create Supplier | Add a new supplier | name, contact?, email?, phone? | New supplier, status=active | FR-010 |
| Update Supplier | Edit supplier details | id, name, contact?, email?, phone? | Updated supplier | FR-011 |
| List Suppliers | Populate Supplier List screen | search?, status? | Matching suppliers | FR-012 |
| Get Supplier | Populate Supplier Detail screen | id | Supplier | FR-012 |
| Set Supplier Status | Activate/deactivate | id, status | Updated supplier | FR-013 — inactive suppliers excluded from the Stock-In supplier picker |

### Product

| Use Case | Purpose | Input | Result | Rules |
|---|---|---|---|---|
| Create Product | Add a new product to the catalog | name, sku, unit, categoryId?, threshold? | New product, status=active | FR-001, BR-001, BR-003 |
| Update Product | Edit product details | id, name, unit, categoryId?, threshold?, sku (only if no history) | Updated product | FR-002, BR-001 |
| List Products | Populate Product List / Dashboard tiles | search?, status?, category?, lowStock?, outOfStock? | Products with computed current stock & low-stock flag | FR-004, FR-042, BR-060/061 |
| Get Product | Populate Product Detail screen | id | Product with computed current stock | FR-004, BR-040 |
| Set Product Status | Activate/deactivate | id, status | Updated product | FR-003, BR-002 |
| Delete Product | Remove a product that was never used | id | Deleted, or rejected if history exists | FR-006, BR-004 |

### Inventory (the core domain)

| Use Case | Purpose | Input | Result | Rules |
|---|---|---|---|---|
| Record Stock In | Receive stock from a supplier (or none) | productId, quantity, date, supplierId? | New transaction, stock increases | FR-020, BR-010–013 |
| Record Stock Out | Remove stock (sale, use, loss) | productId, quantity, date, reason? | New transaction, stock decreases | FR-021, BR-020–022 |
| Record Adjustment | Reconcile a physical count | productId, newQuantity, date, reason | New transaction, stock set to match the count | FR-022, BR-030–034 |
| List Product Transactions | Populate a product's history panel | productId | That product's transactions, newest first | FR-030, BR-050/051 |
| List All Transactions | Populate the global Inventory History screen | type?, productId?, supplierId?, days? | Matching transactions across all products | FR-031, BR-050/051 |

### Dashboard

| Use Case | Purpose | Input | Result | Rules |
|---|---|---|---|---|
| Get Dashboard Summary | Populate the Dashboard screen | — | Active/low-stock/out-of-stock counts, last-7-days transaction count, recent activity | FR-050 (composes the above — owns no data of its own) |

---

## Cross-reference to REST endpoints

See `docs/api.md` for the concrete endpoint list once implemented.
