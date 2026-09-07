import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { InventoryTransaction } from './inventory-transaction.entity';

// Phase 19 (docs/phase-19-plan.md §1). The grouped-subquery join that computes a
// product's current stock — `SUM(quantity_delta)` over `inventory_transactions` —
// as a column on a products query, so a caller gets stock in the same round-trip
// that reads the products instead of a second one.
//
// Phase 14 Fork B introduced this shape inline in `ProductsService.findAll`; Phase
// 17 copied the *pattern* (a different aggregate, over `products`) into
// `CategoriesService.findAll`. Phase 19's caller — `DashboardService.getSummary` —
// wants the *identical* query `findAll` runs, so this is the one that gets extracted
// rather than copied a third time: two code paths that must produce the same column
// should not be two pieces of SQL. `findAll` now calls this too.
//
// `inventory_transactions.product_id` is indexed (`IDX_2520d97de0c9a0fbfc9b00f4c1`,
// `InitSchema`), so the `GROUP BY` has support. No migration — a computed column in
// a read is not a schema change (the same note Phases 14 and 17 made).

// The join alias, exported so callers can add their own expressions over the
// aggregate — `ProductsService.findAll` adds a `hasHistory` select and the
// `status=low` / `status=out` WHERE conditions on top of it.
export const STOCK_AGG_ALIAS = 'stock_agg';

// The current-stock scalar. COALESCE turns the LEFT JOIN miss for a product with no
// transactions into 0 rather than SQL NULL — a product nobody has moved stock for is
// at zero, not unknown. Exported so `findAll`'s low/out filters compare against the
// exact same expression this adds as the `currentStock` column.
export const CURRENT_STOCK_EXPR = `COALESCE(${STOCK_AGG_ALIAS}.stock, 0)`;

// Adds the join and the `currentStock` raw column to `qb` and returns it (chainable).
// The column comes back on `getRawAndEntities().raw[i].currentStock` as a numeric
// string (COALESCE over a bigint SUM) — the caller's job to `Number()` it.
export function joinCurrentStock<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  productAlias = 'product',
): SelectQueryBuilder<T> {
  return qb
    .leftJoin(
      (sub) =>
        sub
          .select('tx.product_id', 'product_id')
          .addSelect('SUM(tx.quantity_delta)', 'stock')
          .from(InventoryTransaction, 'tx')
          .groupBy('tx.product_id'),
      STOCK_AGG_ALIAS,
      `${STOCK_AGG_ALIAS}.product_id = ${productAlias}.id`,
    )
    .addSelect(CURRENT_STOCK_EXPR, 'currentStock');
}
