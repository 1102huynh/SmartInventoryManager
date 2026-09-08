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
| "Current Stock" as its own entity | No, modeled as a derived value | Current stock is a computed projection of a product's transactions, not an independently-owned entity with its own lifecycle (BR-040, BR-042). **It is materialised as of Phase 23** (`products.current_stock`) for read performance — still not a first-class domain entity, just a stored projection of the transaction history kept equal to a fresh replay by the write-path invariant BR-043. |
| User | Yes, minimal | Needed for transaction attribution and login; role/permission modeling deferred. |
| Sale / Order | Not included (Future) | Q-4 (product.md) is **resolved** (Phase 18) toward the lighter form: a stock-out carries an optional `reasonCategory`, and `sale` is one value in that enum — no customer, no price, no line items (Q-1). A first-class Sale/Order entity would only be needed to record *who* bought something or to itemise one outbound movement, neither of which is in scope; it stays Future. See BR-023, `docs/phase-18-plan.md`. |
| Purchase Order | Not included (Future) | Procurement workflow is explicitly postponed. |
| Warehouse / Location | Not included (Future) | Single-location assumption (A-1). |
| Audit Event | Yes, as supporting [Added 2026-08-25, Phase 9] | Records who did what, to what, and when — for authentication and administrative writes. Owns no invariants of the core domain; the core domain (stock movement) functions identically whether or not this entity exists. See `docs/phase-9-plan.md`. |
| Adjustment Request | Yes, as supporting [Added 2026-09-03, Phase 12] | A proposal by a Staff user to correct a product's stock, pending an Owner's approval. The core domain functions identically without it — an Owner's adjustment still records immediately, and current stock is still the sum of `inventory_transactions`. A request contributes nothing to stock until approval turns it into a transaction. Same framing Audit Event got. See `docs/phase-12-plan.md`. |

## 4. Main Entities & Responsibilities

### Product
Represents an item the business stocks and tracks. Responsible for holding identity (SKU),
descriptive information, unit of measurement, status (Active/Inactive), and its low-stock
threshold. Does not hold its own "quantity" field as a source of truth — quantity is derived
from its transactions. It *does* carry a materialised `current_stock` column as of Phase 23,
but that is a stored copy of the derivation, not an editable field: it is only ever rewritten
from the transaction history, on every stock write, under the product-row lock (BR-042/BR-043).

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
an optional reason and an optional reason category for stock-out — Phase 18, BR-023).
Once created, a transaction is never modified or removed.

### User
Represents a person operating the system. Holds real login credentials (a unique email and
a hashed password, as of Phase 3) and is responsible for authentication and for being the
attributable actor on every Inventory Transaction. Role/permission distinctions are not
modeled yet — `role` is descriptive metadata only, not enforced (A-5).

### Adjustment Request (supporting, Should Have) [Added 2026-09-03, Phase 12]
Represents a Staff member's proposal to set a product's stock to a counted total,
awaiting an Owner's decision. The distinction the whole feature turns on: **a request
is a proposal about the future; a transaction is a record of the past.** Responsible
for holding the product, the counted total (`new_quantity`, not a delta — Q-UI-2), the
reason (BR-032), the stock the requester saw, the requester, and — once resolved — the
status (`pending`/`approved`/`rejected`/`withdrawn`), the resolver, the resolution
reason, and a link to the `inventory_transactions` row an approval created. A pending
request performs no stock change; approval computes the delta against current stock
under lock (BR-086) and records a transaction attributed to the **requester** (BR-088).
A resolved request is terminal (BR-087). See `docs/phase-12-plan.md`.

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
Product          1 ── * Adjustment Request       [Phase 12]
User             1 ── * Adjustment Request        (requested by / resolved by) [Phase 12]
Adjustment Request  0..1 ── 1 Inventory Transaction  (the transaction an approval created) [Phase 12]
```

Current stock for a Product is derived by aggregating all of its Inventory Transactions
(sum of stock-in and positive adjustments, minus stock-out and negative adjustments).
Since Phase 23 that sum is **stored** on the Product (`current_stock`) and recomputed
from the full history on every stock write; the derivation is unchanged, only its
enforcement point moved from "every read" to "every write" (BR-042/BR-043).

## 6. Important Invariants

- A Product's current stock (materialised since Phase 23 as `products.current_stock`,
  and equal to it) is always the sum of its Inventory Transactions and can never be
  negative. The stored column is rewritten from that sum on every stock write, under
  the product-row lock — never patched incrementally. (BR-040, BR-041, BR-042, BR-043)
- Every Inventory Transaction references exactly one Product.
- Inventory Transactions are immutable once recorded; corrections happen only by recording
  new transactions (adjustments). (BR-051)
- A Stock-In or Stock-Out transaction cannot be created against an Inactive Product. (BR-013)
- An Adjustment transaction always carries a reason. (BR-032)
- A Stock-Out transaction may carry an optional reason category from a fixed set; no
  other transaction type may (a DB `CHECK`). When the category is `other`, the
  free-text reason note is mandatory. (BR-023) [Phase 18]
- A Product with any existing Inventory Transaction history cannot be deleted, only
  deactivated. (BR-004) A Product with a *pending* Adjustment Request also cannot be
  deleted. (BR-089) [Phase 12]
- A pending Adjustment Request contributes nothing to a Product's current stock — only
  the Inventory Transaction an approval creates does. (BR-085) [Phase 12]

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
  two since `InitSchema`). **[Noted 2026-09-08, Phase 23]** The materialised
  `products.current_stock` (BR-043) is rewritten by a raw, targeted `UPDATE` that does
  **not** touch `updated_at` — deliberately. `updated_at` on a catalogue row means
  "someone edited this product's own attributes" (name, SKU, threshold, status); a
  stock movement is recorded on `inventory_transactions` with its own `occurred_at` and
  `created_at`, and letting every stock-in bump the product's `updated_at` would blur
  that meaning. The derived column moving is not the product being edited.
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
  rather than a one-off observation about `inventory_transactions`. **[Updated
  2026-09-08, Phase 22]** The rule is about the absence of `UPDATE` and of a *targeted*
  `DELETE` — nothing edits a row or removes a chosen one — and that still holds. It
  never implied unlimited retention, and Phase 9 §7 always flagged retention as a
  separate, coming decision: Phase 22 (BR-090) bounds `audit_events` to a rolling
  one-year window via a bulk, time-based prune. So the two tables §8 has cited together
  since Phase 9 now diverge on purpose — `inventory_transactions` is immutable *and*
  kept for good, because BR-050/BR-051 make it business history; `audit_events` is
  immutable-in-shape but no longer retained forever, because a small business's audit
  log is operational evidence with a shelf life (BR-082's "a record, not a proof").
- **`adjustment_requests`** [Added 2026-09-03, Phase 12] — the **fourth mutable
  table**, so both `created_at` and `updated_at` (`timestamptz`, per the Phase 10
  convention — this is the first table created since that convention named a type). A
  request's status field changes on approval/rejection/withdrawal, so unlike
  `inventory_transactions` and `audit_events` it genuinely has something for an
  `updated_at` to record.

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

**[Added 2026-09-08, Phase 21]** `throttle_hits` (`docs/phase-21-plan.md`, issue #11)
is **not a domain entity** and does not appear in the sections above — it is an
operational/cache table holding `@nestjs/throttler`'s per-client request counts so the
rate limits survive running the API as more than one instance. It deliberately carries
**no** `created_at`/`updated_at`: this section's convention is about audit facts, and a
disposable counter the next request overwrites has nothing to audit — the same call as
the missing `updated_at` on the immutable tables, for the opposite reason. Its one
timestamp, `expires_at`, is server-set operational state and so `timestamptz`, per the
`users.locked_until` precedent.

## 9. Cross-References

- Entities here are governed by rules in `business-rules.md` (see rule → entity references
  above).
- Entities here fulfill requirements in `requirements.md` (see FR → BR → domain
  cross-reference table there).
