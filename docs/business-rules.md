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
- **BR-023** [Decided 2026-09-07, Phase 18] — **Optional reason category.** A stock-out
  may carry a `reasonCategory` from a fixed, closed set — `sale`, `internal_use`,
  `damaged`, `lost`, `expired`, `return`, `other` — or none at all (FR-021 is
  unchanged: the reason has always been optional). When the category is `other`, the
  free-text `reason` note is **mandatory and non-empty** — an unexplained "Other"
  carries no information, the same posture BR-032 takes for adjustments. A reason
  category is meaningful **only on a stock-out**: `inventory_transactions` has a DB
  `CHECK` (`type = 'stock_out' OR reason_category IS NULL`), mirrored by the entity's
  `@Check` decorator, so a stock-in or adjustment can never carry one. The value is
  part of the immutable transaction row (BR-051) — a correction is a new transaction,
  never an edit. `sale` is the lightest possible modelling of a sale: one enum value,
  no customer, no price (Q-1). Resolves `product.md` Q-4; a full `Sale`/`Order` entity
  stays Future. → FR-025, FR-021, BR-051

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
- **BR-042** [Confirmed; mechanism amended 2026-09-08, Phase 23] — **Consistency.**
  Current stock must always be reproducible by replaying the product's full transaction
  history — the two can never diverge. **As of Phase 23 it is stored**, as
  `products.current_stock` (a materialisation, `docs/phase-23-plan.md`, issue #13), so
  that the Product List and dashboard reads no longer aggregate the whole (unprunable)
  `inventory_transactions` table on every request. The guarantee is kept *mechanically*
  by BR-043: every stock write recomputes the column from the product's full history
  under the pessimistic product-row lock, so the stored value and a fresh replay are
  equal at every commit. The column is never incrementally patched and no read trusts
  it without that guarantee. → FR-024
- **BR-043** [Decided 2026-09-08, Phase 23] — **The write-path invariant that keeps
  BR-042 true.** Every code path that records a stock-in, stock-out, or adjustment does
  so through the one locked write (`InventoryService.insertTransaction`) that, after
  inserting the transaction row, rewrites `products.current_stock` to
  `COALESCE(SUM(quantity_delta), 0)` over that product's history — inside the same
  transaction and the same `SELECT … FOR UPDATE` on the product row that BR-041 relies
  on. No path adds a delta to the stored value or reads it back without a recompute; a
  value left wrong by a bug self-heals on that product's next write. → BR-040, BR-041,
  BR-042, FR-024

## Inventory History

- **BR-050** [Confirmed] — **What must be recorded.** Every stock-in, stock-out, and
  adjustment transaction must record: product, transaction type, quantity, date/time, and
  the user who performed it. Stock-in additionally records the supplier (if applicable);
  adjustments additionally record the reason; a stock-out may additionally record a
  reason category and a free-text note (BR-023, Phase 18). → FR-030, FR-031, FR-061
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
- **BR-072** [Decided 2026-08-20, Phase 5; amended 2026-09-03, Phase 12] —
  **Initiating stock movement is open to both roles; a Staff-initiated adjustment does
  not change stock without an Owner's approval.** Recording a stock-in or stock-out, and
  *initiating* an adjustment, requires only an authenticated user of either role. As of
  Phase 12 a Staff-initiated adjustment is a **request** that changes no stock until an
  Owner approves it (BR-085); an Owner-initiated adjustment is still recorded
  immediately. The original entry read "This is **not** a resolution of Q-6 … Q-6
  remains open"; both halves now change — **Q-6 is resolved** (`product.md` §10) in the
  narrow form BR-085 states. The amendment is written here with its date, the way BR-074
  amended BR-073, rather than left for a reader to reconcile two rules that disagree.
  → FR-062, FR-020, FR-021, FR-022, FR-066
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
  event types (`docs/phase-9-plan.md` §1) is written to `audit_events` as it happens.
  Rows are never *updated*, and never individually deleted — the one deletion path is
  the age-based retention prune (**BR-090**, added Phase 22), which is bulk and
  time-based and cannot target a chosen row, so the log stays append-only in the sense
  that matters for trust: no specific event can be quietly altered or removed. The
  record names the **actor** (the authenticated principal who acted, `NULL` for anonymous
  events) and the **subject** (the account the event is about) as two distinct facts
  — a failed login has a subject and no actor, because the person who typed the wrong
  password is precisely not the account holder. Recording is **best-effort**: a
  failed audit write never fails the operation it describes
  (`AuditService.record`'s `try/catch`), so the log is a *record*, not a *proof*. The
  client address is captured on authentication events only (`actorIp`, `NULL` on
  every administrative event) — this is personal data, retained at most one year
  (**BR-090**, Phase 22 — before then the table had no retention limit).
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
- **BR-090** [Decided 2026-09-08, Phase 22] — **The audit log is pruned to a rolling
  one-year window.** An `audit_events` row whose `created_at` is more than a year old
  is deleted. This is the retention policy Phase 9 §7 deferred by name, with its
  trigger ("a slow audit screen, or a backup size that surprises someone") now met —
  the table grows without any user acting, almost entirely from `login_failed`, so
  left unbounded its size is a function of how long the business has run. The prune is
  **best-effort and has no scheduler**: an opportunistic probabilistic sweep on
  `AuditService.record()` (the same 1-in-1000 mechanism Phase 21 gave `throttle_hits`)
  plus one unconditional pass at startup. Like the write it guards (BR-082), a failed
  prune is logged and swallowed, so a sustained run of failures would let the table
  grow again silently — the trade a 1–10 person business's *record, not proof* accepts.
  The window is a constant, not configuration (`docs/phase-22-plan.md` §1 Fork A). →
  BR-082, FR-065

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

**[2026-09-07, Phase 15]** No new BR — the fourth such line, after Phase 10's, Phase
11's, and Phase 12's "no new `AuditEventType`" (below). `docs/phase-15-plan.md` adds a
CI pipeline (`.github/workflows/ci.yml`): it runs the existing test suite on a clean
environment on every push. It enforces nothing about the business — it enforces that
the code enforcing the business still passes its own tests. No rule here is added,
amended, or reinterpreted; no application code changes at all.

**[2026-09-07, Phase 14]** No new BR — the fifth such line, and the direct sibling of
Phase 11's. `docs/phase-14-plan.md` gives the four catalogue list reads (`/products`,
`/suppliers`, `/categories`, `/users`) an optional `page`/`pageSize` and a paged
envelope. A paging window is a property of a read, not a rule about the business:
BR-060/061 (low stock), BR-002 (product status), and BR-070–074 (who may read what)
all say exactly what they said before. The Fork B rewrite of `ProductsService.findAll`
— computing current stock in SQL so `low`/`out` are `WHERE` clauses — changes how the
answer is computed, not what it is; BR-040/042's "current stock is `SUM(quantity_delta)`,
never a stored column" is untouched (the value is still summed on read, just in the
same query now). `requirements.md`'s Phase 14 note carries the FR-004 "all" reading,
the counterpart to Phase 11's FR-030/031 note. (Landed after Phase 15 in wall-clock —
CI was built first — but numbered before it.)

**[2026-09-07, Phase 16]** No new BR — the sixth such line. `docs/phase-16-plan.md`
makes the CI `lint` step blocking and clears the eslint tree (a formatting sweep, one
test-only rule relaxed, two dead variables removed). It changes no business behaviour:
the full backend suite passes unchanged (14/143, 7/90).

**[2026-09-07, Phase 17]** No new BR — the seventh such line. `docs/phase-17-plan.md`
makes the stock-in supplier field and the Inventory History product filter
type-to-search controls, and gives the Categories screen a server-side product count.
Searching a list and counting its members are not rules about the business: BR-013
(an inactive supplier cannot be selected on a stock-in — still enforced server-side,
the typeahead only queries `status=active`), BR-070–074 (who may read what) all say
exactly what they said before. The category `productCount` is a `COUNT(*)` computed on
read via a subquery join — the same "current stock is `SUM(quantity_delta)`, never a
stored column" posture as BR-040/042, one table over. `requirements.md`'s Phase 17
note carries the "these FRs are unchanged" reading.

**[2026-09-07, Phase 18]** One new BR — **BR-023** (above), the first new BR since
Phase 12. `docs/phase-18-plan.md` resolves `product.md` Q-4 in its lighter form: an
optional stock-out `reasonCategory` from a fixed set, stored as a real enum column
(migration `1787930000000`) and guarded by a DB `CHECK` that only a stock-out row may
carry one. FR-021 is unchanged — a stock-out with no category is still valid, and no
existing row, seed, or API caller had to change (the column is nullable, no default,
no backfill). This is a genuine new rule, not a "no new BR" note: it is what closes
the oldest open product question, and "sale" as one enum value is the deliberate
lightweight answer to "do we need a `Sale`/`Order` entity" — no (a full one stays
Future, `product.md` §7).

**[2026-09-07, Phase 19]** No new BR — the eighth such line, following Phase 17's
seventh (Phase 18 added one in between). `docs/phase-19-plan.md` (issue #9) makes
`DashboardService.getSummary` read products and their current stock in one query
instead of two, reusing Phase 14 Fork B's grouped-subquery join. It **reaffirms**
BR-040/BR-042 rather than touching them: current stock is still `SUM(quantity_delta)`
computed on demand, never a stored or cached column — this phase only moves the `SUM`
from a second round-trip into the products query. BR-060/BR-061 (low-stock flagging
needs a configured threshold) and BR-062 (`needsAttention` is the low-stock list only)
are unchanged and still enforced in the same place, in the same words.

**[2026-09-07, Phase 20]** No new BR — the ninth such line (Phases 12 and 18 added rules
in between the eight before it). `docs/phase-20-plan.md` (issue #10) deletes the Phase 1
navigable-mockup scaffolding — `UI.mockFetch`, `UI.previewControl`, the per-view
`?state=` / `override` handling — that Phase 13 §7 deferred removing until "the real
backend's error and empty states can be exercised another way in development." It is a
frontend-only deletion: no rule about the business, no backend file, no route, no
migration. The empty-list and error panels every list screen renders are unchanged in
wording and behaviour; only the review-only control that forced them without a backend is
gone, and each screen now chooses its "nothing yet" vs. "no matches" copy from whether a
filter is actually active.

**[2026-09-08, Phase 21]** No new BR — the tenth such line. `docs/phase-21-plan.md`
(issue #11) gives `@nestjs/throttler` a shared, Postgres-backed store (`throttle_hits`,
a custom `ThrottlerStorage`) in place of its default per-process `Map`, so the limits
BR-079 describes still hold when the API runs as more than one instance. It **reaffirms**
BR-079–081 rather than touching them: the rules say authentication attempts are
rate-limited per client address and repeated failures lock an account — *where the
throttle keeps its count* is an implementation fact, not a rule. Account lockout
(`users.failed_login_attempts`/`locked_until`) was already Postgres-backed and is
unchanged; this closes the gap the throttle side carried.

**[2026-09-08, Phase 23]** One new BR (**BR-043**, above) and one amended (**BR-042**) —
the first change to this section since Phase 12, and the first since Phase 18 that is
not a "no new BR" note. `docs/phase-23-plan.md` (issue #13) materialises current stock
as `products.current_stock` so the Product List and dashboard reads stop summing the
whole of `inventory_transactions` on every request — the successor Phase 11 §7 named
and Phase 14 Fork B / Phase 19 re-parked, acted on now because Phase 22 closed the
same "cost grows with how long the business has run" shape for `audit_events` and named
`inventory_transactions` as the table its prune could not reach. BR-040 (current stock
is the net of a product's transactions, a derived value) and BR-041 (never negative)
are **unchanged in meaning**; BR-042 keeps its guarantee but now names the stored
column and the recompute-on-write mechanism, and BR-043 states that write-path
invariant. `requirements.md` carries the "no new FR" note (reading a number that means
what it always meant is still FR-023/FR-024).

**[2026-09-08, Phase 24]** No new BR — the eleventh such line, and back to the "no new
BR" shape after Phase 23. `docs/phase-24-plan.md` (issue #14) `EXPLAIN`-measures the
Phase 14 paged catalogue query and decides **not** to add an index on `products.name` /
`suppliers.name` (the `users` ordering is already the primary-key B-tree). Whether a
read is backed by an index is an implementation fact about performance, not a rule about
the business — the same reason the Phase 21 shared-throttle-store change filed a "no new
BR" line. No BR is touched, reaffirmed, or amended; no schema changes.

**[2026-09-08, Phase 25]** No new BR — the twelfth such line. `docs/phase-25-plan.md`
(issue #15) promotes `@typescript-eslint/no-floating-promises` and `no-unsafe-argument`
from `warn` to `error` in `backend/eslint.config.mjs`. How strictly the build checks
its own async-call hygiene is an engineering-practice fact, not a rule about the
business — the same reason the Phase 15 CI pipeline and the Phase 16 lint gate each
carried a "no new BR" line. No BR is touched, reaffirmed, or amended; no schema, no
application code.

## Adjustment Approval

- **BR-085** [Decided 2026-09-03, Phase 12] — **A Staff-initiated adjustment is a
  request; an Owner-initiated one is immediate.** When a Staff user submits an
  adjustment (`POST /products/:id/adjustments`), the server creates a **pending
  adjustment request** that changes no stock — current stock is still
  `SUM(quantity_delta)` over `inventory_transactions` (BR-040), and a pending request
  contributes nothing to it. When an Owner submits, the transaction is recorded
  immediately, exactly as before this phase. A pending request lives in its own table
  (`adjustment_requests`), never as a mutable `inventory_transactions` row — BR-051 is
  untouched. → FR-022, FR-066, BR-072
- **BR-086** [Decided 2026-09-03, Phase 12] — **The delta is computed at approval, not
  at request time.** The request stores the new *counted total* (`new_quantity`,
  Q-UI-2), never a `+/-` delta. `quantity_delta` is computed when the Owner approves,
  against current stock **under the same pessimistic row lock `recordAdjustment`
  already takes** (`docs/learning-notes/database-transactions.md`). A stored delta
  would go stale if stock moved between request and approval; "the count was 40" does
  not. If drift has made the count a no-op by approval time (current stock already
  equals `new_quantity`), approval is rejected with `409` and the request stays
  pending for the Owner to reject — no `superseded` status is invented for one `if`
  branch. BR-052 is **not** re-checked at approval (a past date does not become a
  future one). → FR-066, BR-030, BR-052
- **BR-087** [Decided 2026-09-03, Phase 12] — **Who may do what, and terminality.**
  Submit: any authenticated user. Approve and reject: Owner only. Withdraw: the
  requester, and only while pending. **No self-approval** — the approver must not be
  the requester (this arises the moment a Staff member with a pending request is
  promoted to Owner; if they are then the only active Owner, they withdraw and
  re-submit, which now goes through the Owner path). A resolved request is terminal:
  no un-reject, no re-open, no edit — a superseded count is a *new* request, in the
  spirit of BR-051. Reject and withdraw carry a **mandatory** `resolution_reason`
  (mirrors BR-032); approve's is optional. The four statuses are `pending`,
  `approved`, `rejected`, `withdrawn` — a withdrawal ("I changed my mind about my own
  count") is a different fact from a rejection ("the Owner did not accept it"), the
  same reasoning BR-082 gives for keeping actor and subject as two columns. The
  approve/reject/withdraw gate is enforced in `AdjustmentsService`, not by
  `@Roles()` — the first authorization rule in the app that depends on the actor's
  relationship to the row, not only on the token
  (`docs/learning-notes/authentication-and-guards.md`). → FR-066
- **BR-088** [Decided 2026-09-03, Phase 12] — **An approved adjustment's transaction
  is attributed to the requester.** `inventory_transactions.recorded_by_user_id` on
  the row an approval inserts is the **requester** — the person who performed the
  count and typed the number — not the approver, who permitted it (FR-061). Recording
  the approver would make that column mean two different things depending on which
  path a row came from, and would lose the requester from the ledger. The approver is
  not lost: `adjustment_requests` names them, and the request is reachable from the
  transaction by `resulting_transaction_id`. → FR-061, FR-066
- **BR-089** [Decided 2026-09-03, Phase 12] — **A product with a pending request
  cannot be deleted.** BR-004 blocks deleting a product with transaction history; a
  product with no transactions but a **pending** adjustment request is otherwise
  deletable, and the `RESTRICT` foreign key would surface as a `500`. `DELETE
  /products/:id` gains an explicit check producing the documented `409`, extending
  BR-004's principle to a row that is not yet history. → FR-006, FR-066, BR-004

**No new `AuditEventType` was added** (Fork C, `docs/phase-12-plan.md` §1) — the
counterpart to Phases 10 and 11's "no new BR" lines. `adjustment_requests` already
records requester, approver, both timestamps, the outcome, and the resolution reason;
writing the same facts into `audit_events` would be a second record of one fact that
can drift (BR-083's own objection), and would put the app's highest-frequency workflow
into the low-frequency table Phase 9 §1 built for administrative rarities. **Revisit
trigger:** if the audit screen ever becomes the single place an Owner reconstructs
"everything that happened," the answer is a read-side union across the two tables
(Phase 9 §7's unified-activity-feed shape), never a second write.

## Rules Explicitly Deferred (Future scope, not defined now)

- Pricing/cost rules (cost of goods, valuation) — depends on product.md Q-1.
- Multi-location stock allocation rules.
- Purchase-order-to-stock-in matching rules.
- Batch/lot/expiry rules.
- **General** approval workflow rules — approval on any write other than a
  Staff-initiated adjustment, configurable approver chains, magnitude thresholds
  ("only adjustments over N units need approval"). Adjustment approval itself is **no
  longer deferred** — see BR-085–089 (Phase 12, resolving product.md Q-6). What stays
  Future is approval generalized beyond that one case (`docs/phase-12-plan.md` §7).
