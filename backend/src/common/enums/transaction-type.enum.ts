// domain-model.md: Stock-In, Stock-Out, and Adjustment are three *types* of one
// concept (Inventory Transaction), not three separate entities/tables.
export enum TransactionType {
  STOCK_IN = 'stock_in',
  STOCK_OUT = 'stock_out',
  ADJUSTMENT = 'adjustment',
}
