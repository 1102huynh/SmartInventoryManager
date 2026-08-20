# API Documentation — Phase 2

Status: Phase 2 — NestJS Backend
Base URL: `http://localhost:3000` (see `backend/.env.example`)

All request bodies are JSON. All write endpoints accept an `x-user-id` header
identifying who's performing the action (see `backend-use-cases.md`, "Deferred:
Authentication" — this is attribution, not real auth; it defaults to user `1` if
omitted). Validation errors return `400` with `{ statusCode, message: string[], error }`.
Business-rule violations (insufficient stock, inactive product, duplicate SKU, …)
return `409` with `{ statusCode, message: string, error }`. Not-found resources return
`404` in the same shape. Unexpected errors return a generic `500` (see
`AllExceptionsFilter`) and never leak internals.

## Categories

| Method | Path | Notes |
|---|---|---|
| GET | `/categories` | All categories, alphabetical. Seeded reference data — no write endpoints exist yet. |

## Suppliers

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/suppliers` | `?search=&status=active\|inactive` | |
| GET | `/suppliers/:id` | | 404 if missing |
| POST | `/suppliers` | `{ name, contactName?, email?, phone? }` | |
| PATCH | `/suppliers/:id` | same shape, all optional | |
| PATCH | `/suppliers/:id/status` | `{ status: "active"\|"inactive" }` | |

## Products

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/products` | `?search=&status=active\|inactive\|low\|out&categoryId=` | Response items include computed `currentStock`, `lowStock`, `outOfStock`, `hasHistory` |
| GET | `/products/:id` | | 404 if missing |
| POST | `/products` | `{ name, sku, unit, categoryId?, lowStockThreshold? }` | 409 on duplicate SKU |
| PATCH | `/products/:id` | `{ name, unit, categoryId?, lowStockThreshold?, sku? }` | `sku` change rejected (409) once the product has any transaction history (BR-001) |
| PATCH | `/products/:id/status` | `{ status: "active"\|"inactive" }` | |
| DELETE | `/products/:id` | | 204 on success; 409 if the product has transaction history (BR-004) |

## Inventory (writes — under a product)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/products/:id/stock-in` | `{ quantity, occurredAt, supplierId? }` | 409 if product inactive or supplier inactive/missing |
| POST | `/products/:id/stock-out` | `{ quantity, occurredAt, reason? }` | 409 if product inactive or `quantity` exceeds current stock |
| POST | `/products/:id/adjustments` | `{ newQuantity, occurredAt, reason }` | Allowed even if product is inactive; 400 if `newQuantity` equals current stock (no-op) |

`quantity`/`newQuantity` must be whole numbers (`newQuantity >= 0`, `quantity >= 1`).
`occurredAt` is an ISO date string and cannot be in the future.

## Inventory (reads)

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/products/:id/transactions` | | One product's full history, newest first |
| GET | `/inventory-transactions` | `?type=stock_in\|stock_out\|adjustment&productId=&supplierId=&days=` | Global history; also backs the Supplier Detail "received from" panel via `supplierId` |

Transaction responses embed `product`, `supplier` (nullable), and `recordedBy` as full
nested objects (a joined read) — the frontend never needs a second request to show
names.

## Dashboard

| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard/summary` | `{ activeProductsCount, inactiveProductsCount, lowStockCount, outOfStockCount, transactionsLast7Days, recentActivity: Transaction[], needsAttention: Product[] }` |

`needsAttention` is the low-stock list (BR-060/061), not a merged low-stock +
out-of-stock list — see BR-062 for why an out-of-stock product with no configured
threshold shows up in `outOfStockCount` but not here.

## Users

| Method | Path | Notes |
|---|---|---|
| GET | `/users` | Seeded demo users only — no create/login endpoint exists yet (see "Deferred: Authentication") |
