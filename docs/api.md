# API Documentation — Phase 6

Status: Phase 6 — User Management (Owner-Administered Accounts)
Base URL: `http://localhost:3000` (see `backend/.env.example`)

All request bodies are JSON. **Every route except `POST /auth/login` requires a valid
token** — `Authorization: Bearer <accessToken>` (see "Auth" below and
`docs/phase-3-plan.md`). A missing, malformed, or expired token returns `401`. This
replaces Phase 2's `x-user-id` header, which no longer does anything — attribution
(FR-061) now comes from the verified token, not a client-supplied value.

Routes marked **Owner only** below additionally require the caller's role to be
`owner` (Phase 5, `docs/phase-5-plan.md`) — a valid token from a Staff user gets past
the `401` check but is rejected with `403` on these routes specifically. In short:
**`401` means no valid token; `403` means the wrong role.** Every route without that
marker is open to any authenticated user, either role. A deactivated user's token
(Phase 6, `docs/phase-6-plan.md`) gets `401`, not `403` — they aren't a wrong-role
caller, they aren't a caller at all.

**One documented exception to "`401` means no valid token": `PATCH /auth/password`**
also returns `401` for a wrong `currentPassword`, even though the caller's token is
perfectly valid — deliberately, because the failure is "you haven't proven you're this
user," the same category as a failed login, not a role or validation failure (see its
row below and `docs/phase-6-plan.md` §1). A client that treats every `401` as "log the
user out" needs to special-case this one route.

Validation errors return `400` with `{ statusCode, message: string[], error }`.
Business-rule violations (insufficient stock, inactive product, duplicate SKU, …)
return `409` with `{ statusCode, message: string, error }`. Not-found resources return
`404` in the same shape. Unexpected errors return a generic `500` (see
`AllExceptionsFilter`) and never leak internals.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | The only route not requiring a token. `401` on wrong email/password — deliberately the same message for both, so the response never reveals which one was wrong. A **deactivated** account gets a *different* `401` message ("This account has been deactivated…") — deliberately not generic, since reaching it requires the password to have already matched (Phase 6, `docs/phase-6-plan.md` §1). On success: `{ accessToken, user: { id, name, role } }`, where `role` is `"owner"` or `"staff"` (Phase 5). Token expires after 12h (no refresh token — see `docs/phase-3-plan.md`). |
| GET | `/auth/me` | — | Returns the caller's own user record (resolved from the token), minus `passwordHash`. |
| PATCH | `/auth/password` | `{ currentPassword, newPassword }` | Any authenticated user, own account only. `204` on success. `401` if `currentPassword` doesn't match — proving who's sitting at the tab now, not just who opened it. `newPassword` must be at least 8 characters. |

## Categories

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/categories` | | All categories, alphabetical. |
| POST | `/categories` | `{ name }` | **Owner only.** 409 on duplicate name. |
| PATCH | `/categories/:id` | `{ name }` | **Owner only.** 404 if missing; 409 on duplicate name. |
| DELETE | `/categories/:id` | | **Owner only.** 204 on success; any product referencing this category has its `categoryId` set to `null` (`ON DELETE SET NULL`). |

## Suppliers

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/suppliers` | `?search=&status=active\|inactive` | |
| GET | `/suppliers/:id` | | 404 if missing |
| POST | `/suppliers` | `{ name, contactName?, email?, phone? }` | **Owner only.** |
| PATCH | `/suppliers/:id` | same shape, all optional | **Owner only.** |
| PATCH | `/suppliers/:id/status` | `{ status: "active"\|"inactive" }` | **Owner only.** |

## Products

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/products` | `?search=&status=active\|inactive\|low\|out&categoryId=` | Response items include computed `currentStock`, `lowStock`, `outOfStock`, `hasHistory` |
| GET | `/products/:id` | | 404 if missing |
| POST | `/products` | `{ name, sku, unit, categoryId?, lowStockThreshold? }` | **Owner only.** 409 on duplicate SKU |
| PATCH | `/products/:id` | `{ name, unit, categoryId?, lowStockThreshold?, sku? }` | **Owner only.** `sku` change rejected (409) once the product has any transaction history (BR-001) |
| PATCH | `/products/:id/status` | `{ status: "active"\|"inactive" }` | **Owner only.** |
| DELETE | `/products/:id` | | **Owner only.** 204 on success; 409 if the product has transaction history (BR-004) |

## Inventory (writes — under a product)

Open to any authenticated user, either role (BR-072) — deliberately not Owner-only;
see `docs/phase-5-plan.md` §1 "Adjustments stay open to Staff".

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

**The whole controller is Owner-only** — a single class-level `@Roles(UserRole.Owner)`
on `UsersController` (BR-074, amending BR-073), including `GET`. There is no signup
endpoint (`docs/phase-3-plan.md` "No self-service signup" still holds) and no user
delete endpoint — `PATCH /users/:id/status` is the whole lifecycle (BR-076). No
response body from any of these routes ever includes `passwordHash`.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/users` | | All users, by id. |
| GET | `/users/:id` | | 404 if missing. |
| POST | `/users` | `{ name, email, role, password }` | `201`. Sets the initial password directly — no generated credential, no forced-change-on-first-login. `password` must be at least 8 characters (a floor, not a policy). 409 on duplicate email. |
| PATCH | `/users/:id` | `{ name?, email?, role? }` | Name/email/role only — never password. 409 on duplicate email. 409 (BR-075) when the change would demote the last active Owner. |
| PATCH | `/users/:id/status` | `{ status: "active"\|"inactive" }` | 409 (BR-075) when the change would deactivate the last active Owner. Deactivation takes effect on the user's very next request (BR-077), not at their token's expiry. |
| PATCH | `/users/:id/password` | `{ newPassword }` | `204`. An Owner's *reset*, not a *recovery* — no current password required, the old one is never shown. `newPassword` must be at least 8 characters. |
