# Business Rules — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-20

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
  - [Noted 2026-08-24, Phase 7] This is *why* `inventory_transactions` has a
    `created_at` column and no `updated_at`: a row that can never change has nothing
    for an `updated_at` to ever record. See `domain-model.md` §8 "Audit Timestamps"
    for the full created-vs-updated convention, applied here and to every other
    table.
- **BR-052** [Confirmed, documented 2026-08-20, Phase 4 review] — **Date cannot be in the
  future.** A transaction's `occurredAt` date cannot be later than today. This applies
  identically to stock-in, stock-out, and adjustment — it's a property of recording history
  at all, not something specific to any one transaction type, so it lives here rather than
  duplicated under each type's own section. Enforced by
  `InventoryService.assertNotFuture`, called from all three write paths; this rule was
  already implemented before this entry was written — see phase-4-plan.md §0/§4. → FR-020,
  FR-021, FR-022

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

## Authorization

- **BR-070** [Decided 2026-08-20, Phase 5] — **Two roles.** Exactly two roles exist,
  Owner and Staff (`users_role_enum`); every user has exactly one. No third role, no
  per-permission table — see `docs/phase-5-plan.md` §1. → FR-062
- **BR-071** [Decided 2026-08-20, Phase 5] — **Master data is Owner-only.** Creating,
  editing, deactivating, or deleting a Product, Supplier, or Category requires the
  Owner role. Enforced by `RolesGuard` on the ten routes listed in `docs/api.md`. →
  FR-062, FR-001, FR-002, FR-003, FR-006, FR-010, FR-011, FR-013, FR-005
- **BR-072** [Decided 2026-08-20, Phase 5] — **Stock movement is open to both roles.**
  Recording a stock-in, stock-out, or adjustment requires only an authenticated user,
  of either role. This is **not** a resolution of Q-6 (adjustment approval workflow,
  product.md) — it is a role gate, not a workflow, and Q-6 remains open. → FR-062,
  FR-020, FR-021, FR-022
- **BR-073** [Decided 2026-08-20, Phase 5; amended 2026-08-21, Phase 6] — **Reads are
  open to both roles.** Every read — products, suppliers, categories, transactions,
  dashboard, `/auth/me` — is available to any authenticated user regardless of role,
  **except the user list, which BR-074 makes Owner-only.** The user list is a
  different kind of read than inventory data: it's the index page of an
  administrative screen, and after Phase 6 it carries every colleague's login email
  and account status. → FR-062
- **BR-074** [Decided 2026-08-21, Phase 6] — **User administration is Owner-only.**
  Creating, editing, deactivating, reactivating, or resetting the password of a user
  account — including reading the user list — requires the Owner role. This is an
  explicit amendment to BR-073, not a quiet exception: leaving the user list open to
  Staff would make Phase 3's identical-401-for-unknown-email-vs-wrong-password care
  (`AuthService.validateUser`'s comment, `docs/phase-3-plan.md`) pointless from inside
  the app, since any signed-in user could just read the list. Enforced by a single
  class-level `@Roles(UserRole.Owner)` on
  `UsersController` — the first controller in the app to apply it at the class level
  rather than per-route, because every route on it, including `GET`, is Owner-only. →
  FR-063
- **BR-075** [Decided 2026-08-21, Phase 6] — **At least one active Owner must always
  exist.** A change that would leave zero active Owners is rejected with `409`.
  Applies to both paths that can violate it: demoting the last active Owner to Staff,
  and deactivating the last active Owner. "Active" is part of the rule — a deactivated
  Owner can't log in, so counting one toward the minimum would permit a state that
  satisfies the letter of the rule while locking everyone out in practice. An Owner
  may demote or deactivate *themselves*, provided another active Owner remains; the
  rule protects the system, not any one account. → FR-063
- **BR-076** [Decided 2026-08-21, Phase 6] — **Users are deactivated, never deleted.**
  There is no user delete endpoint. `inventory_transactions.recorded_by_user_id` is a
  `RESTRICT` foreign key, so FR-061 attribution would be worthless if the row it
  points at could vanish — the same principle BR-004 already applies to products with
  transaction history, extended here to every user without exception (a user with zero
  transactions still isn't deleted; the account exists because a person exists). →
  FR-061, FR-063, BR-004
- **BR-077** [Decided 2026-08-21, Phase 6] — **Deactivation blocks authentication
  immediately, not just future logins.** An inactive user cannot obtain a new token
  (`POST /auth/login` returns `401`), and an *existing, unexpired* token belonging to
  an inactive user is rejected with `401` on that user's very next request — not at
  the token's expiry. This is the one case Phase 3's declined token-revocation list
  (`docs/phase-3-plan.md`) turns out not to need: Phase 5's per-request database
  lookup for role freshness (`JwtStrategy.validate`) already pays for it. → FR-063,
  FR-060
- **BR-078** [Decided 2026-08-21, Phase 6; amended 2026-08-24, Phase 8] — **Two
  password-change paths, no email-based recovery.** A user changes their own
  password by supplying the current one (`PATCH /auth/password`, `401` if it doesn't
  match); an Owner may reset any user's password without knowing it
  (`PATCH /users/:id/password`) — a reset, not a recovery, since the old password is
  never shown. No email-based reset exists; there is no mail transport in this
  project. An Owner's reset (but not a self-service change) also clears a BR-080
  lock — see that rule for why one route does both jobs. → FR-063, FR-064
- **BR-079** [Decided 2026-08-24, Phase 8] — **Authentication attempts are
  rate-limited.** Requests to `POST /auth/login` and `PATCH /auth/password` are
  capped per client address per window (defaults: 10 attempts / 5 minutes); exceeding
  the cap returns `429`, and the request never reaches password verification. A
  generous global cap (default 120 requests / 60 seconds) applies to
  every other route as a backstop. The throttler guard runs first, ahead of
  `JwtAuthGuard` and `RolesGuard`, so a flood is rejected before any database lookup
  or password hash comparison — see `docs/phase-8-plan.md` §1. → FR-060
- **BR-080** [Decided 2026-08-24, Phase 8] — **Consecutive failed logins lock an
  account temporarily.** Five consecutive failures (configurable) lock the account
  for fifteen minutes (configurable); the lock expires on its own, a successful login
  resets the counter, and **further failures during a lock do not extend it** — a
  script firing one guess a minute must not be able to keep an account locked
  forever. An Owner's password reset (BR-078) clears a lock; there is no other manual
  unlock, and no permanent lock exists — a lock that only an Owner could clear would
  have a state where the last active Owner (BR-075) is locked out of their own system
  with no recovery. → FR-060, FR-063
- **BR-081** [Decided 2026-08-24, Phase 8] — **A lock is not a deactivation, and
  never reveals whether an account exists.** A locked account's specific message
  ("Too many failed attempts…") is returned only after the supplied password has
  already matched; every other failure returns the same generic `401` as an unknown
  email (Phase 3) — the same enumeration-safety ordering BR-077's deactivation
  message already relies on, applied to a second state. Unlike deactivation
  (BR-077), a lock does **not** revoke an existing token — `JwtStrategy.validate` has
  no lock check, so a locked account's already-issued, unexpired token keeps working;
  the lock blocks *obtaining* a new one, not using one already held. → FR-060

## Audit Log

- **BR-082** [Decided 2026-08-25, Phase 9] — **Every administrative and
  authentication event is recorded, and the record is append-only.** A closed list of
  event types (`docs/phase-9-plan.md` §1) is written to `audit_events` as it happens;
  rows are never updated or deleted by any code path in this application. The record
  names the **actor** (the authenticated principal who acted, `NULL` for anonymous
  events) and the **subject** (the account the event is about) as two distinct facts
  — a failed login has a subject and no actor, because the person who typed the wrong
  password is precisely not the account holder. Recording is **best-effort**: a
  failed audit write never fails the operation it describes
  (`AuditService.record`'s `try/catch`), so the log is a *record*, not a *proof*. The
  client address is captured on authentication events only (`actorIp`, `NULL` on
  every administrative event) — this is personal data, in a table with no retention
  limit (see "Explicitly out of scope," Phase 9 §7).
  - **Not every credential-verification failure is recorded.** `PATCH
    /auth/password` (a self-service password change) records nothing when the
    supplied *current* password is wrong — a deliberate exclusion, not an oversight.
    The closed list in `docs/phase-9-plan.md` §1 covers authentication (login) and
    administrative writes; a wrong `currentPassword` is neither — the caller already
    holds a valid token, so the only realistic guesser is the account's own holder
    fumbling their own password (the same reasoning BR-079's throttle-without-lock
    treats this route by). It is the one credential-verification failure in the app
    that leaves no trace in `audit_events`; `PATCH /auth/password`'s throttle
    response (BR-079) still applies. Revisit if this route is ever given its own
    lockout.
  - **`audit_events.actor_user_id`/`subject_user_id` are real `RESTRICT` foreign
    keys to `users`** (safe only because of BR-076 — a `users` row can never
    disappear out from under an audit row). One consequence worth naming: any
    out-of-band `DELETE FROM users` (there is no in-app path that does this — see
    BR-076) now fails once that user has so much as logged in once, exactly the way
    it already failed once that user had recorded an `inventory_transactions` row.
    `backend/test/roles.e2e-spec.ts`'s orphaned-token test had to learn this — see
    its own comment. → BR-076
  → FR-065
- **BR-083** [Decided 2026-08-25, Phase 9] — **Stock movements are not duplicated
  into the audit log.** `inventory_transactions` is already the immutable, attributed
  record of every stock-in, stock-out, and adjustment (BR-050, BR-051). The audit log
  records what happens *to* the system — accounts, roles, credentials, catalog data,
  authentication — never what happens *in* it. Two records of one fact could drift,
  and the ordinary daily traffic would bury the handful of administrative events the
  log exists for. → BR-050, BR-051
- **BR-084** [Decided 2026-08-25, Phase 9] — **The audit log is Owner-only.** It
  contains failed login attempts against named accounts — not merely which accounts
  exist, but which are currently being attacked and which are close to lockout.
  Phase 3 closed enumeration from the outside and BR-081 closed it from a second
  direction; opening this read to Staff would reopen it from the inside. Enforced by
  a class-level `@Roles(UserRole.Owner)` on `AuditController`, the second controller
  to use the class-level form after BR-074's `UsersController`. → FR-065, BR-074

BR-078 gains a cross-reference: an Owner's reset is recorded as `user_password_reset`
(BR-082), and the lock it clears is visible in the same log (`setPassword`'s summary
notes the clear).

**[2026-08-25, Phase 10]** No new BR. `docs/phase-10-plan.md`'s schema-wide
`timestamptz` conversion is a column type, not a rule about the business — BR-051's
immutability, BR-052's future-date check, BR-080's fifteen-minute lock, and BR-082's
append-only record all say exactly what they said before. BR-080 gains a
cross-reference only: converting `locked_until` closes a narrower gap than the audit
columns' — not "the two processes disagree about a zone, continuously" (that never
applied to this column; see below), but a fifteen-minute lock surviving a restart onto a
differently-zoned host, or a DST transition between the lock and the check, without
drifting.

How exposed the lock actually was under plain `timestamp` took three attempts to state
correctly, settled by experiment rather than by re-reading the driver source a third
time (`docs/phase-10-plan.md` §1's `locked_until` bullet and §5 have the full history).
`locked_until` is an application-computed value with no database default to defer to —
unlike `created_at`/`updated_at`, which TypeORM fills in via the database's own
`DEFAULT`/`CURRENT_TIMESTAMP` and which therefore share `DEFAULT now()`'s exposure to
Postgres's session zone. Reverting `locked_until` alone to `type: 'timestamp'` under a
harness that reliably breaks the audit columns left it round-tripping correctly: its
write and its read both happen in Node's zone, so the everyday mismatch this phase
otherwise closes never applied to it. Its actual, narrower exposure is the one this
paragraph opens with.

**[2026-08-27, Phase 11]** No new BR, the second such line after Phase 10's. A cap on
a read is a property of a transport, not a rule about the business. BR-050 (what must
be recorded), BR-051 (immutability), and BR-062 (dashboard scope) all say exactly what
they said before — which rows a client receives changes nothing about what is true of
the rows. `docs/phase-11-plan.md` §1 records why FR-030/FR-031's word "all" is a
statement about the screen's subject, not a guarantee about one response, and
`requirements.md`'s Phase 11 note carries that reading.

## Rules Explicitly Deferred (Future scope, not defined now)

- Pricing/cost rules (cost of goods, valuation) — depends on product.md Q-1.
- Multi-location stock allocation rules.
- Purchase-order-to-stock-in matching rules.
- Batch/lot/expiry rules.
- Approval workflow rules for adjustments (product.md Q-6).
