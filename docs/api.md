# API Documentation — Phase 12

Status: Phase 12 — Adjustment Approval
Base URL: `http://localhost:3000` (see `backend/.env.example`)

Every resource response includes `createdAt` (an ISO timestamp, server-set, never
user-supplied); every **mutable** resource — `users`, `products`, `suppliers`,
`categories` — additionally includes `updatedAt`. `inventory_transactions` responses
include `createdAt` only, no `updatedAt` at all — BR-051 makes those rows immutable,
so there's nothing for an `updatedAt` to record (see `domain-model.md` §8). A
transaction response also carries `occurredAt`, a different field entirely: the
user-supplied business date the stock movement happened, not when the row was
written — don't confuse the two when reading one. No route or request body reads or
writes these columns; they ride every existing route's existing shape and role
(Phase 7, `docs/phase-7-plan.md`).

Every timestamp field in every response is an ISO instant, and always has been — as
of Phase 10 (`docs/phase-10-plan.md`), the schema guarantees it rather than a
convention doing so. **No route's shape, status code, or field list changes.**

All request bodies are JSON. **Every route except `POST /auth/login` requires a valid
token** — `Authorization: Bearer <accessToken>` (see "Auth" below and
`docs/phase-3-plan.md`). A missing, malformed, or expired token returns `401`. This
replaces Phase 2's `x-user-id` header, which no longer does anything — attribution
(FR-061) now comes from the verified token, not a client-supplied value.

Routes marked **Owner only** below additionally require the caller's role to be
`owner` (Phase 5, `docs/phase-5-plan.md`) — a valid token from a Staff user gets past
the `401` check but is rejected with `403` on these routes specifically. In short:
**`401` means no valid token; `403` means the wrong role; `429` means slow down**
(Phase 8, below). Every route without an Owner-only marker is open to any
authenticated user, either role. A deactivated user's token (Phase 6,
`docs/phase-6-plan.md`) gets `401`, not `403` — they aren't a wrong-role caller,
they aren't a caller at all.

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

**Phase 8 (`docs/phase-8-plan.md`): rate limiting returns `429`** with the same
`{ statusCode, message, error }` shape as every other error, plus a `Retry-After`
header (seconds until the window clears). `Retry-After` is named in
`Access-Control-Expose-Headers` (Phase 11), so a cross-origin browser caller can read
it — the same mechanism `X-Result-Truncated` relies on. Every route is capped at a
generous global default (120 requests / 60 seconds per client address); `POST
/auth/login` and `PATCH /auth/password` additionally carry a much tighter limit (10
attempts / 5 minutes) — the throttler guard runs first, ahead of `JwtAuthGuard`, so an
over-limit request never reaches password verification (BR-079). Both limits are
configurable (`backend/.env.example`).

**Phase 9 (`docs/phase-9-plan.md`): every write on `/users`, `/products`,
`/suppliers`, and `/categories` now also records an audit event** (BR-082), and every
`POST /auth/login` attempt does too. This is a side effect, not a documented response
change — no route below gains a new field, status code, or error shape because of it;
see the "Audit Log" section for the one new route this phase actually adds.

**Phase 12 (`docs/phase-12-plan.md`): a Staff-initiated adjustment is a request an
Owner approves.** `POST /products/:id/adjustments` now returns `201` + an
`InventoryTransaction` for an Owner (unchanged) or `202` + an `AdjustmentRequest` for a
Staff caller (new — the stock does not change until approval). Two new routes,
`GET /adjustment-requests` and `PATCH /adjustment-requests/:id/status`, back the
`#/approvals` screen. See the "Adjustment Requests" section. `inventory_transactions`
gains no column, constraint, or index — the Phase 11 reads are byte-for-byte unchanged.

**Phase 11 (`docs/phase-11-plan.md`): the two transaction log reads are capped.**
`GET /inventory-transactions` and `GET /products/:id/transactions` now accept `limit`
(default 100, max 500; `1 <= limit <= 500` or `400`, never a silent clamp) and return
at most that many rows, newest-first, with no offset pagination — the same shape
`/audit-events` has carried since Phase 9. When more rows matched than were returned,
the response carries **`X-Result-Truncated: true`**; the header is *absent* otherwise,
so its presence is the signal, not its value. As of Phase 12 it appears on **four**
routes — `/inventory-transactions`, `/products/:id/transactions`, `/audit-events`, and
`/adjustment-requests` (below) — and no others. The four catalogue reads (`/products`,
`/suppliers`, `/categories`, `/users`)
are deliberately **not** capped — a truncated catalogue is a wrong answer where a
truncated log is a reading position; bounding them needs a paging design, deferred
(`docs/phase-11-plan.md` §7).

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | The only route not requiring a token — but rate-limited to 10 attempts / 5 minutes per address (Phase 8, above). `401` on wrong email/password — deliberately the same message for both, so the response never reveals which one was wrong. A **deactivated** account gets a *different* `401` message ("This account has been deactivated…") — deliberately not generic, since reaching it requires the password to have already matched (Phase 6, `docs/phase-6-plan.md` §1). A **locked** account (Phase 8, five consecutive failures) gets a third distinct `401` message ("Too many failed attempts. Try again in N minutes.") — same enumeration-safety rule: only reachable with the correct password (BR-081). The lock does not revoke an already-issued token — see `GET /auth/me`. On success: `{ accessToken, user: { id, name, role } }`, where `role` is `"owner"` or `"staff"` (Phase 5). Token expires after 12h (no refresh token — see `docs/phase-3-plan.md`). |
| GET | `/auth/me` | — | Returns the caller's own user record (resolved from the token), minus `passwordHash`. Still works for a **locked** account's existing token (BR-081) — a lock blocks obtaining a new token, not using one already held. Still `401` for a **deactivated** account's token, immediately (BR-077, unchanged). |
| PATCH | `/auth/password` | `{ currentPassword, newPassword }` | Any authenticated user, own account only. Rate-limited the same as login (Phase 8), but **not** subject to account lockout — the caller already holds a valid token, so a wrong `currentPassword` here is a fumble, not an anonymous guess. `204` on success. `401` if `currentPassword` doesn't match — proving who's sitting at the tab now, not just who opened it. `newPassword` must be at least 8 characters. |

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

Open to any authenticated user, either role (BR-072). Stock-in and stock-out are
unchanged. `POST /products/:id/adjustments` is handled by `AdjustmentsController` as of
Phase 12 (the path is unchanged — Nest routes by decorator, not by module) and has two
outcomes:

| Method | Path | Body | Caller | Response | Notes |
|---|---|---|---|---|---|
| POST | `/products/:id/stock-in` | `{ quantity, occurredAt, supplierId? }` | either | `201` + `InventoryTransaction` | 409 if product inactive or supplier inactive/missing |
| POST | `/products/:id/stock-out` | `{ quantity, occurredAt, reason? }` | either | `201` + `InventoryTransaction` | 409 if product inactive or `quantity` exceeds current stock |
| POST | `/products/:id/adjustments` | `{ newQuantity, occurredAt, reason }` | **Owner** | `201` + `InventoryTransaction` | Recorded immediately (unchanged). Allowed even if product inactive; `400` if `newQuantity` equals current stock (no-op) |
| POST | `/products/:id/adjustments` | `{ newQuantity, occurredAt, reason }` | **Staff** | `202` + `AdjustmentRequest` | A pending request — **stock does not change**. `404` if the product is missing; `400` if `occurredAt` is in the future |

`quantity`/`newQuantity` must be whole numbers (`newQuantity >= 0`, `quantity >= 1`).
`occurredAt` is an ISO date string and cannot be in the future.

## Adjustment Requests (Phase 12)

Open to both roles for reading (BR-073) — a Staff member who submitted a count needs to
see whether it was accepted. **An Owner's `GET /adjustment-requests` returns the whole
queue; a Staff caller's is scoped server-side to their own requests** (by the
authenticated id, not a client-supplied `requestedByUserId` param, so it cannot be
widened). The approve/reject/withdraw gate on the PATCH is enforced in the service, not
by `@Roles()`, because legality depends on the actor's relationship to the row
(approve/reject → Owner; withdraw → the requester) — the first route in the app whose
authorization is not fully expressible as `@Roles(...)`.

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET | `/adjustment-requests` | `?status=pending\|approved\|rejected\|withdrawn&productId=&days=&limit=` | Newest-first (`created_at DESC, id DESC`), capped — `limit` default 100, max 500 (`400`, never a silent clamp); `days >= 1`. `X-Result-Truncated: true` when more matched, absent otherwise. Each item also carries a computed `currentStock` and `delta` (`newQuantity - currentStock`) recomputed on every load — a *preview* of what an approval right now would do, not a promise. |
| PATCH | `/adjustment-requests/:id/status` | `{ status: "approved"\|"rejected"\|"withdrawn", reason? }` | `404` unknown; `409` if the request is not pending (a resolved request is terminal); `403` on self-approval, on a non-Owner approving/rejecting, or on a non-requester withdrawing; `400` if `reason` is missing on a reject or withdraw; `409` with the count-now-matches message if drift has made the count a no-op. On approve: inserts an `inventory_transactions` row **attributed to the requester** (BR-088) in the same database transaction as the status flip, and the response carries the request with its `resultingTransaction` populated. |

`?days=N` on `/adjustment-requests` carries the same calendar contract as
`/inventory-transactions` and `/audit-events` — exactly `N` calendar dates ending with
today. `created_at` is a real instant (like `/audit-events`, unlike
`/inventory-transactions`' date-only `occurred_at`), so it reaches that contract by the
instant-column cutoff — see `backend/src/common/days-cutoff.ts`.

`AdjustmentRequest` response shape: `{ id, productId, product, newQuantity, occurredAt,
reason, status, requestedByUserId, requestedBy: User, stockAtRequest, resolvedByUserId,
resolvedBy: User|null, resolutionReason: string|null, resultingTransactionId:
number|null, resultingTransaction: InventoryTransaction|null (only on the PATCH
response), currentStock, delta, createdAt, updatedAt }`. `adjustment_requests` is the
fourth mutable table, so it carries `updatedAt` (contrast `inventory_transactions` and
`audit_events`).

## Inventory (reads)

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/products/:id/transactions` | `?limit=` | One product's history, newest first (`occurred_at DESC, id DESC`), capped — `limit` default 100, max 500. `X-Result-Truncated: true` when more matched. |
| GET | `/inventory-transactions` | `?type=stock_in\|stock_out\|adjustment&productId=&supplierId=&days=&limit=` | Global history; also backs the Supplier Detail "received from" panel via `supplierId`. Newest first (`occurred_at DESC, id DESC`), capped — `limit` default 100, max 500; `days >= 1`. `X-Result-Truncated: true` when more matched. |

Both reads are ordered `occurred_at DESC, id DESC` — the `id` tie-break matters:
`occurred_at` is a user-supplied date-only value, so a whole business day's rows are
identical in it, and a `LIMIT` over `occurred_at` alone would return an arbitrary
subset of a tie (`docs/phase-11-plan.md` §1). `limit` and `days` are validated — an
out-of-range value is `400`, never silently reinterpreted. There is no offset or
cursor pagination; "the most recent N, narrow with filters" is the whole model.

**`?days=N` covers exactly `N` calendar dates, ending with today.** `?days=7` returns
transactions dated **today and the previous six dates**; `?days=1` returns today alone.
A transaction dated six days ago is included, one dated seven days ago is not. The
answer does not change with the hour the request is made — the cutoff is the start of
the date `N - 1` days back, not `N` days back with the current clock left on it. This
is a calendar window, not a rolling 168-hour one, and not eight inclusive dates.
`/audit-events?days=N` carries the identical contract, so "Last N days" means one thing
across the API (its `createdAt` is a real instant rather than a date, so it reaches that
contract by a different cutoff — see `backend/src/common/days-cutoff.ts`).

**An unsupported query parameter on either route is `400`, not ignored.** Both now bind
a DTO, and the global `ValidationPipe` runs with `forbidNonWhitelisted: true`, so
`?foo=1` — or a misspelled `?limits=50` — is rejected rather than silently dropped.
Worth stating because `GET /products/:id/transactions` bound no DTO before Phase 11 and
therefore ignored every query parameter it was given; a client appending a cache-buster
to that URL would have been fine before and is not now.

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
response body from any of these routes ever includes `passwordHash` — and, as of
Phase 8, never `failedLoginAttempts` or `lockedUntil` either (both `@Exclude()`d,
same as `passwordHash`; operational security state, not safe to expose even to other
authenticated users via a nested `recordedBy`). As of Phase 9, every write below
(`POST`/`PATCH`/`PATCH .../status`/`PATCH .../password`) also records an event in the
audit log — see "Audit Log" below.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/users` | | All users, by id. Each item includes a computed `locked: boolean` (Phase 8) — the raw `lockedUntil` timestamp is never exposed, only whether it's currently in the future. |
| GET | `/users/:id` | | 404 if missing. Same `locked: boolean` as the list. |
| POST | `/users` | `{ name, email, role, password }` | `201`. Sets the initial password directly — no generated credential, no forced-change-on-first-login. `password` must be at least 8 characters (a floor, not a policy). 409 on duplicate email. Response is the serialized `User` entity — no `locked` field (a brand-new account is never locked; `locked` is only computed on the two `GET` routes above). |
| PATCH | `/users/:id` | `{ name?, email?, role? }` | Name/email/role only — never password. 409 on duplicate email. 409 (BR-075) when the change would demote the last active Owner. Response has no `locked` field, same reason as `POST` above — re-fetch via `GET` to see current lock status. |
| PATCH | `/users/:id/status` | `{ status: "active"\|"inactive" }` | 409 (BR-075) when the change would deactivate the last active Owner. Deactivation takes effect on the user's very next request (BR-077), not at their token's expiry. |
| PATCH | `/users/:id/password` | `{ newPassword }` | `204`. An Owner's *reset*, not a *recovery* — no current password required, the old one is never shown. `newPassword` must be at least 8 characters. Also clears a Phase 8 lock (BR-078/BR-080) — this is the unlock mechanism; there is no separate unlock route. |

## Audit Log

**Owner only** — a single class-level `@Roles(UserRole.Owner)` on `AuditController`
(BR-084), the second controller in the app to use the class-level form after
`UsersController` above. Newest-first (`id DESC` — already a total order, so no
tie-break was needed here, unlike the transaction reads), no offset pagination —
filters plus a `limit` (default 100, max 500; a larger request is `400`, not silently
clamped) are the only way to narrow a result. As of Phase 11, a capped response also
carries **`X-Result-Truncated: true`** — this route had been truncating silently since
Phase 9 and no longer does. A read event's `actor` and `subject`
are full nested `User` objects (a joined read, the same choice `GET
/inventory-transactions` makes for `recordedBy`) — `null` on either when there's no
actor (every anonymous authentication event) or no subject (an administrative event
about a product, supplier, or category, not a user). `entityType`/`entityId` name the
non-user target of an administrative event and are **not** a foreign key — an event
about a deleted product still names it, by id, after the product itself is gone
(BR-082).

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/audit-events` | `?eventType=&actorUserId=&subjectUserId=&days=&limit=` | `eventType` is one of the closed list in `docs/phase-9-plan.md` §1 (`login_succeeded`, `login_failed`, `account_locked`, `password_changed`, `user_created`, `user_updated`, `user_status_changed`, `user_password_reset`, `product_created`, `product_updated`, `product_status_changed`, `product_deleted`, `supplier_created`, `supplier_updated`, `supplier_status_changed`, `category_created`, `category_updated`, `category_deleted`). `days` and `limit` are both validated (`days >= 1`, `1 <= limit <= 500`) — an out-of-range value is `400`, never silently reinterpreted. `days=N` carries the same contract as `/inventory-transactions`: exactly `N` calendar dates ending with today, so `days=7` is today plus the previous six dates and `days=1` is today alone. |

Response items: `{ id, eventType, actor: User|null, actorUserId: number|null, subject: User|null, subjectUserId: number|null, entityType: string|null, entityId: number|null, summary: string, actorIp: string|null, createdAt }`. `actorIp` is set only on authentication events (`login_succeeded`/`login_failed`/`account_locked`) — `null` on every administrative one (scope fork A, `docs/phase-9-plan.md` §1). `summary` is a short human sentence composed by the service that recorded the event — never a field-level diff, and never a password, hash, or token.

**Not every `401` on this API reaches the audit log.** `PATCH /auth/password`'s wrong-`currentPassword` case (above) records nothing — the caller already holds a valid token, and the closed list this phase records covers authentication (login) and administrative writes, neither of which that case is (BR-082).
