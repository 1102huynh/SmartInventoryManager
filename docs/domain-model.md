# Conceptual Domain Model — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-20

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
| Audit Event | Yes, as supporting [Added 2026-08-25, Phase 9] | Records who did what, to what, and when — for authentication and administrative writes. Owns no invariants of the core domain; the core domain (stock movement) functions identically whether or not this entity exists. See `docs/phase-9-plan.md`. |

## 4. Main Entities & Responsibilities

### Product
Represents an item the business stocks and tracks. Responsible for holding identity (SKU),
descriptive information, unit of measurement, status (Active/Inactive), and its low-stock
threshold. Does not hold its own "quantity" field as a source of truth — quantity is derived
from its transactions.

### Category (supporting, Should Have)
Groups products for organization/filtering. Has no behavior of its own beyond
classification — still true after Phase 4, which added create/update/delete for
categories themselves (`docs/phase-4-plan.md`); that's CRUD on the entity, not new
behavior the entity performs. Flat only, by design — no parent/subcategory relationship
(Q-5, resolved).

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

### Audit Event (supporting, Should Have) [Added 2026-08-25, Phase 9]
Represents a single authentication or administrative event — a login attempt, an
account lockout, a password change, or a create/edit/status-change/delete on a User,
Product, Supplier, or Category. Responsible for naming the **actor** (who performed
it, if anyone authenticated did) and the **subject** (the account it's about) as two
distinct facts, a short human-readable summary, and when it happened. Has no
behavior of its own beyond being written once and read — no code path updates or
deletes a row here. Deliberately does not record inventory movement
(`inventory_transactions` already owns that, BR-083) or reads. See
`docs/phase-9-plan.md`.

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

## 8. Audit Timestamps

Every table records `created_at` — set once, server-side, on insert, never
user-supplied. A table whose rows can change after creation additionally records
`updated_at` — bumped on every save of that row; a table whose rows are immutable
does not, because there is nothing for it to ever record. **[Updated 2026-08-25,
Phase 10]** Every server-set timestamp column is `timestamptz` — the convention now
names a type, not just a naming rule. See `docs/phase-10-plan.md` §1 and
`architecture-observations.md`'s resolved entry for why: a `timestamp without time
zone` stores a clock reading, not an instant, and it records no zone alongside the
digits. Every writer here — Postgres's `DEFAULT now()` and TypeORM's
`@CreateDateColumn`/`@UpdateDateColumn` alike — writes those digits in Postgres's
session zone; every read reinterprets them in Node's. The two only ever agreed because
both processes run on one machine today, and nothing checked that they did.

- **`products`, `suppliers`, `users`, `categories`** — mutable rows, so all four carry
  both columns (`users`/`categories` since Phase 7, `docs/phase-7-plan.md`; the other
  two since `InitSchema`).
- **`inventory_transactions`** — the worked example of the immutable case: `created_at`
  only. BR-051 makes a recorded transaction immutable — corrections happen only by
  recording a new transaction, never by editing an old one — so an `updated_at` on
  this table would be a column whose value could only ever equal `created_at`. Its
  absence is a direct consequence of that rule, not an oversight (see the entity
  comment on `InventoryTransaction`).
- **`audit_events`** [Added 2026-08-25, Phase 9] — the **second** instance of the
  immutable case, for the same reason: BR-082 makes a recorded event append-only, so
  `created_at` only, no `updated_at`. Having a second instance is itself a small
  piece of evidence that the immutable-table rule above was worth writing as a rule
  rather than a one-off observation about `inventory_transactions`.

**`occurred_at` vs. `created_at`** — easy to conflate on `inventory_transactions`,
the one entity that has both:
- `occurred_at` (`timestamptz`, user-supplied, cannot be in the future per BR-052) is
  a **business fact**: when the stock movement happened in the world. It can be
  backdated to record yesterday's delivery.
- `created_at` (`timestamptz DEFAULT now()`, server-set) is an **audit fact**: when
  the row was written to the database. It can never be backdated and carries no
  business meaning.

**[Added 2026-08-25, Phase 10]** Before this phase the two columns were also
distinguishable by type — `occurred_at` was `timestamptz`, `created_at` was a plain
`timestamp` — which made the business-fact/audit-fact distinction legible from the
schema alone. Both are `timestamptz` now, so that distinction is carried entirely by
the column names and by this subsection's prose; the type was never *encoding* the
distinction; it was encoding "someone thought harder about this one column."

`Product`, `Supplier`, `User`, and `Category` have no business-event time of their
own — there's no "when did this account come into existence in the world" distinct
from "when was the row inserted" — so they carry only the audit kind.

These columns are readable by anyone who can read the row and settable by no one;
they carry no access-control weight of their own and inherit whatever role rule
already governs their table's routes.

## 9. Cross-References

- Entities here are governed by rules in `business-rules.md` (see rule → entity references
  above).
- Entities here fulfill requirements in `requirements.md` (see FR → BR → domain
  cross-reference table there).
