# Conceptual Domain Model — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-19

This is a **conceptual** domain model: it describes the business concepts, their
responsibilities, and their relationships. It intentionally excludes database schemas,
tables, columns, ORM entities, and API DTOs — those belong to the later Architecture phase.

## 1. Core Domain

**Inventory Movement & Stock Tracking** — this is the reason the product exists. Its
responsibility is to record every change to stock (in, out, adjustment) and to make current
stock and stock health (low-stock status) always accurate and traceable. Everything else in
the system exists to support this core.

## 2. Supporting Domains

- **Product Catalog** — defines *what* can be stocked (Product, optionally Category).
- **Supplier Management** — defines *who* stock is received from (Supplier).
- **User Identity** — defines *who* performs actions, for accountability (User), and *who
  may act at all* (real authentication as of Phase 3 — see `docs/phase-3-plan.md`).
  Permissions modeling beyond "authenticated or not" stays deferred (A-5).
- **Reporting (Dashboard)** — not an independent domain with its own data; it is a read-only
  view composed from Inventory Movement + Product Catalog data (counts, recent activity,
  low-stock list). It owns no entities of its own.

## 3. Entities Evaluated

| Candidate Entity | Included? | Rationale |
|---|---|---|
| Product | Yes | Core — every transaction refers to a product. |
| Category | Yes, as supporting/optional | Organizational aid only; a product remains fully functional without one. Not required for core invariants. |
| Supplier | Yes, as supporting | Needed to attribute stock-in and answer "where did this come from," but the inventory model works even if supplier is omitted on a transaction (see product.md Q-2). |
| Inventory Transaction | Yes | Core — the single source of truth for all stock movement (stock-in, stock-out, adjustment are three *types* of the same concept, not three separate entities). |
| "Current Stock" as its own entity | No, modeled as a derived value | Current stock is a computed projection of a product's transactions, not an independently-owned entity with its own lifecycle (BR-040, BR-042). It may be *materialized* for performance later, but conceptually it is not a first-class domain entity. |
| User | Yes, minimal | Needed for transaction attribution and login; role/permission modeling deferred. |
| Sale / Order | Not included (Future) | Only relevant if Q-4 (product.md) resolves toward stock-out modeling a sale with price/customer. Not part of the current concept. |
| Purchase Order | Not included (Future) | Procurement workflow is explicitly postponed. |
| Warehouse / Location | Not included (Future) | Single-location assumption (A-1). |

## 4. Main Entities & Responsibilities

### Product
Represents an item the business stocks and tracks. Responsible for holding identity (SKU),
descriptive information, unit of measurement, status (Active/Inactive), and its low-stock
threshold. Does not hold its own "quantity" field as a source of truth — quantity is derived
from its transactions.

### Category (supporting, Should Have)
Groups products for organization/filtering. Has no behavior of its own beyond classification.

### Supplier
Represents an external source of stock. Responsible for identity and contact information,
and status (Active/Inactive). Referenced by stock-in transactions.

### Inventory Transaction
The central entity of the domain. Represents a single, immutable event that changes a
product's stock. Responsible for recording: the product affected, the transaction type
(Stock-In / Stock-Out / Adjustment), the quantity delta, the date/time, the user who
performed it, and type-specific context (supplier for stock-in; reason for adjustment;
optional reason for stock-out). Once created, a transaction is never modified or removed.

### User
Represents a person operating the system. Holds real login credentials (a unique email and
a hashed password, as of Phase 3) and is responsible for authentication and for being the
attributable actor on every Inventory Transaction. Role/permission distinctions are not
modeled yet — `role` is descriptive metadata only, not enforced (A-5).

## 5. Relationships

```
Product          1 ── * Inventory Transaction
Supplier         1 ── * Inventory Transaction   (stock-in transactions only)
Category         1 ── * Product                 (optional; a Product may have 0 or 1 Category)
User             1 ── * Inventory Transaction    (performed by)
```

Current stock for a Product is derived by aggregating all of its Inventory Transactions
(sum of stock-in and positive adjustments, minus stock-out and negative adjustments).

## 6. Important Invariants

- A Product's current stock (however computed or materialized) is always the sum of its
  Inventory Transactions and can never be negative. (BR-040, BR-041, BR-042)
- Every Inventory Transaction references exactly one Product.
- Inventory Transactions are immutable once recorded; corrections happen only by recording
  new transactions (adjustments). (BR-051)
- A Stock-In or Stock-Out transaction cannot be created against an Inactive Product. (BR-013)
- An Adjustment transaction always carries a reason. (BR-032)
- A Product with any existing Inventory Transaction history cannot be deleted, only
  deactivated. (BR-004)

## 7. Domain Boundaries

- **In the core domain**: Product, Inventory Transaction, and the derivation of current
  stock and low-stock status from it.
- **Supporting, loosely coupled**: Supplier and Category — the core domain functions
  correctly even in their absence (e.g., a stock-in without a supplier, a product without a
  category), they only enrich context.
- **Outside this model entirely (Future)**: pricing/valuation, procurement (purchase
  orders), multi-location stock, batch/lot/expiry, sales/orders, permissions/roles. These
  are not represented by any entity above and should not be assumed by the UI mockup unless
  explicitly reintroduced.
- **Dashboard is not a domain** — it is a presentation-layer composition of existing data
  and has no entities of its own.

## 8. Cross-References

- Entities here are governed by rules in `business-rules.md` (see rule → entity references
  above).
- Entities here fulfill requirements in `requirements.md` (see FR → BR → domain
  cross-reference table there).
