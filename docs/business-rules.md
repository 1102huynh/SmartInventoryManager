# Business Rules — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-19

Each rule is marked **[Confirmed]** (directly follows from the project concept) or
**[Assumption]** (a reasonable default that should be validated during UI review). See
`requirements.md` for the FR each rule supports, and `domain-model.md` for the entities
involved.

## Product

- **BR-001** [Confirmed] — **Product identity.** Every product is uniquely identified by a
  SKU (stock-keeping unit identifier). All inventory transactions reference a product by
  this identity. → FR-001, FR-002
- **BR-002** [Confirmed] — **Product status.** A product is either Active or Inactive.
  Inactive products are excluded from new stock-in and stock-out transactions but remain
  visible in historical records. → FR-003
- **BR-003** [Assumption] — **Product availability requirements.** A product must have a
  name, a SKU, and a unit of measurement before it can be used in any transaction. →
  FR-001
- **BR-004** [Confirmed] — **No hard delete with history.** A product that has any
  transaction history cannot be permanently deleted, to preserve audit integrity; it can
  only be deactivated. → FR-006

## Stock In

- **BR-010** [Confirmed] — **Inventory increase.** A stock-in transaction increases the
  product's current stock by the recorded quantity. → FR-020
- **BR-011** [Assumption] — **Required information.** A stock-in transaction requires a
  product, a positive quantity, and a date. Supplier is recorded when supplier tracking is
  enabled; whether it is mandatory is open (see product.md Q-2). → FR-020
- **BR-012** [Confirmed] — **Validation.** Quantity must be a positive whole number; zero or
  negative quantities are rejected. → FR-020
- **BR-013** [Assumption] — Stock-in cannot be recorded against an Inactive product. →
  FR-020, BR-002

## Stock Out

- **BR-020** [Confirmed] — **Inventory decrease.** A stock-out transaction decreases the
  product's current stock by the recorded quantity. → FR-021
- **BR-021** [Assumption] — **Insufficient stock behavior.** A stock-out transaction cannot
  reduce current stock below zero; if requested quantity exceeds current stock, the
  transaction is rejected. (Default: no negative/backorder stock in MVP — should be
  confirmed.) → FR-021, BR-041
- **BR-022** [Assumption] — **Validation.** Quantity must be a positive whole number and
  cannot exceed current available stock. → FR-021

## Adjustment

- **BR-030** [Confirmed] — **Purpose.** Adjustments exist to reconcile system-recorded stock
  with actual physical stock (damage, loss, theft, stocktake discrepancies, correction of
  data-entry errors). → FR-022
- **BR-031** [Confirmed] — **Quantity change.** An adjustment can either increase or
  decrease current stock by the recorded quantity delta. → FR-022
- **BR-032** [Confirmed] — **Required reason.** Every adjustment must include a reason. The
  reason may be free text or a selected reason category; a reason is mandatory in either
  case. → FR-022
- **BR-033** [Assumption] — A downward adjustment cannot bring current stock below zero,
  consistent with BR-041. → FR-022, BR-041
- **BR-034** [Confirmed] — **Auditability.** Adjustments are recorded as immutable
  transactions, identical in permanence to stock-in and stock-out. → FR-022, BR-051

## Current Stock

- **BR-040** [Confirmed] — **Meaning.** Current stock for a product is the net result of all
  its stock-in, stock-out, and adjustment transactions; it is a derived value, not an
  independently editable field. → FR-023, FR-024
- **BR-041** [Confirmed] — Current stock can never be negative. → BR-021, BR-033
- **BR-042** [Confirmed] — **Consistency.** Current stock must always be reproducible by
  replaying the product's full transaction history — the two can never diverge. → FR-024

## Inventory History

- **BR-050** [Confirmed] — **What must be recorded.** Every stock-in, stock-out, and
  adjustment transaction must record: product, transaction type, quantity, date/time, and
  the user who performed it. Stock-in additionally records the supplier (if applicable);
  adjustments additionally record the reason. → FR-030, FR-031, FR-061
- **BR-051** [Confirmed] — **Immutability.** Recorded transactions cannot be edited or
  deleted. Corrections are made by recording a new adjustment transaction, never by altering
  history. → FR-022, FR-030

## Low Stock

- **BR-060** [Confirmed] — **Determination.** A product is considered low-stock when its
  current stock is less than or equal to its configured low-stock threshold. → FR-041
- **BR-061** [Assumption] — **Threshold configuration.** The threshold is set per product by
  the user. Behavior when no threshold is set (e.g., treated as "no threshold configured,
  never flagged" vs. a system default) is open — see product.md Q-3. → FR-040
- **BR-062** [Decided 2026-08-20, Phase 2.1 review] — **Dashboard "needs attention" scope.**
  The dashboard's `needsAttention` list is exactly the low-stock list (BR-060/061) — the
  same set FR-042 already defines — not a merged low-stock + out-of-stock list. A product
  that is out of stock but has no threshold configured therefore contributes to
  `outOfStockCount` (FR-050) without appearing in `needsAttention`; this is intentional,
  not an oversight:
  - FR-050 explicitly composes the dashboard from FR-042 ("view low-stock list"), not from
    a separate out-of-stock requirement — `outOfStockCount` is dashboard-level convenience,
    not something `needsAttention` is obligated to absorb.
  - For any product that *does* have a threshold, being out of stock already implies
    low-stock (`0 <= threshold` whenever `threshold >= 0`), so it already appears in
    `needsAttention`. The only excluded case is a product with no threshold set at all —
    exactly the case BR-061 already says is never flagged, applied consistently.
  - Merging the two would make an unconfigured product louder on the dashboard than a
    configured one someone deliberately tuned — the opposite of what threshold
    configuration is for.
  → FR-050, FR-042, BR-060, BR-061. See `docs/api.md` (Dashboard) and
  `DashboardService.getSummary` for where this is implemented.

## Rules Explicitly Deferred (Future scope, not defined now)

- Pricing/cost rules (cost of goods, valuation) — depends on product.md Q-1.
- Multi-location stock allocation rules.
- Purchase-order-to-stock-in matching rules.
- Batch/lot/expiry rules.
- Approval workflow rules for adjustments (product.md Q-6).
