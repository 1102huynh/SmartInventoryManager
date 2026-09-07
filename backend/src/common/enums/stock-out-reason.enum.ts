// Phase 18 (docs/phase-18-plan.md), resolving product.md Q-4: a stock-out can
// optionally say *why* stock left, from this fixed set. `sale` is the lightest
// possible expression of "modelling a sale" — no customer, no price (Q-1 already
// resolved "no pricing anywhere in the MVP"), just the category. A full Sale/Order
// entity stays Future (product.md §7, domain-model.md §2).
//
// The value is stored in inventory_transactions.reason_category (its own Postgres
// enum), the structured counterpart to the free-text `reason` column. `other` is the
// escape hatch and requires a `reason` note (BR-023, enforced in CreateStockOutDto).
export enum StockOutReason {
  SALE = 'sale',
  INTERNAL_USE = 'internal_use',
  DAMAGED = 'damaged',
  LOST = 'lost',
  EXPIRED = 'expired',
  RETURN = 'return',
  OTHER = 'other',
}
