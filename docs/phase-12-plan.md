# Phase 12 Plan — Adjustment Approval (Q-6)

Status: Phase 12 — Done
Last updated: 2026-09-03
Scope decided with the project owner: **answer `product.md` Q-6 — a Staff-initiated
adjustment becomes a request that an Owner approves or rejects before it changes stock,
and an Owner's own adjustment is unchanged** — and nothing else. Scoped the same way
`phase-3-plan.md` was scoped to authentication, `phase-5-plan.md` to authorization,
`phase-6-plan.md` to user management, `phase-7-plan.md` to audit timestamps,
`phase-8-plan.md` to rate limiting and lockout, `phase-9-plan.md` to the audit log,
`phase-10-plan.md` to `timestamptz`, and `phase-11-plan.md` to bounded reads: one
headline change, an explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

Q-6 has been open since `product.md` was written and has been deferred **by name** in
seven consecutive phase plans:

| Phase | What it said about Q-6 |
|---|---|
| 5 | BR-072 is "a role gate, not a workflow… Q-6 remains open" |
| 6 | untouched |
| 7 | untouched |
| 8 | untouched |
| 9 | "not a resolution of Q-6 despite the surface resemblance: a log records what happened; an approval gates what may happen" |
| 10 | "still open, still untouched, still not resolved by anything here" |
| 11 | "Seven consecutive phases have now deferred it by name, which by Phase 10 §'Why this phase''s own logic is starting to be an argument in itself." |

Phase 11 wrote that last line itself, and it is the honest reason this phase exists:
**nothing new was learned at any of those seven deferrals.** Each one restated the
previous one. A question that is re-deferred with no new information is not being
deferred; it is being avoided, and this project's own standard — set by Phase 10, which
closed a question after three deferrals precisely because "an entry that only ever grows
is not evidence of anything" (`architecture-observations.md`) — says to settle it.

Three things make the question answerable now rather than in Phase 5, where it was first
declined:

- **The role split exists and is enforced.** BR-070–073 gave the system Owner and Staff
  with real server-side teeth. In Phase 5 an approval workflow would have needed to
  invent an approver; today `RolesGuard` already names one, and BR-075 guarantees at
  least one active Owner exists to be it.
- **Adjustment is the only unbounded write in the system, and the census says so.** Of
  the three stock writes, stock-in is witnessed by a supplier and bounded by a delivery,
  stock-out is bounded above by current stock (BR-021), and **adjustment is bounded by
  nothing in either direction** — it sets stock to any number a single person types, on
  an active *or* inactive product (Q-UI-1), with a free-text reason (BR-032) nobody
  reviews. It is the one place the system takes one person's number on trust. That was
  as true in Phase 5 as it is now; what has changed is that Phase 9 built the log that
  makes it *visible* after the fact, and a log is detection, not prevention.
- **Phase 9 already drew the distinction this phase acts on.** "A log records what
  happened; an approval gates what may happen." Phase 9 built the first half and said so.
  This is the second half, and it is the same sentence's other clause rather than a new
  idea.

**This phase changes `product.md` §7, and that is not a side effect.** §7's Future list
currently reads "approval workflows (e.g., adjustment approval — product.md Q-6)". After
this phase, adjustment approval is in scope and *general* approval workflows stay Future.
That is a product-level scope change of a kind only Phase 9 has made before (and smaller,
since Phase 9 added an FR without removing a Future line). It is called out here at the
top rather than discovered in §4 because it is the one thing in this plan a reader could
reasonably object to on grounds of process rather than design.

---

## 1. Design decisions

### Fork 0 — answer Q-6 "yes", answer it "no", or build a general workflow engine

This fork comes before the others because the rest of the plan is void if it goes the
other way, and because "no" is a genuinely defensible answer that this plan should not
pretend is weak.

**The case for closing Q-6 as "a recorded reason is sufficient"** is real. `product.md`
§3 describes a business of 1–10 people who mostly know each other; §7 lists approval
workflows under Future; Phase 9's audit log plus `inventory_transactions`' permanent,
attributed, immutable record already answers "who changed this and why" after the fact,
which for a threat model of *"which of the four of us changed this"* (Phase 9 §7's own
phrasing) may be all that is wanted. And an approval step has a real operational failure
mode with no equivalent today: a correct stocktake correction sits unapplied while the
system knowingly shows the wrong number, and the person who can unblock it is the one
person who is out that week.

**Recommended: answer "yes", in the narrow form** — approval applies to
**Staff-initiated adjustments only**, and an Owner's adjustment is recorded immediately,
exactly as today. This is chosen over the other two options for two reasons:

- It resolves the question Q-6 actually asks ("should adjustments require any approval
  step, e.g. manager confirmation") without building the thing `product.md` §7 defers
  ("approval workflows", plural, general). One entity, one status field, one gate. There
  is no rule engine, no configurable approver chain, no second-approver threshold, and
  no approval on any other write.
- It makes the *no-op* case honest. Requiring an Owner to approve their own adjustment
  is theatre: they are the approving authority, so a second click adds a step and
  removes no trust. The gate exists where a second person genuinely is involved and
  nowhere else — the same reasoning BR-072 used to keep the role gate off stock movement
  generally.

**Rejected: a general approval engine** (configurable per transaction type, per
magnitude threshold, per role, with an approver chain). Nobody has asked for it, every
knob is a second thing to explain in every conversation about why a number is what it
is, and `product.md` §7 keeps it Future. If a threshold ("only adjustments over N
units") is ever wanted, it is a `WHERE` clause added to one branch of one method — see
§7's trigger.

### Fork A — where a pending adjustment lives. Recommended: a new table

This is the sharpest structural decision in the phase and every other one accommodates
it.

A pending adjustment must not change stock. Current stock is `SUM(quantity_delta)` over
`inventory_transactions` (BR-040, `InventoryService.getCurrentStock`), so there are
exactly two places a pending adjustment could sit:

- **A1 — a new `adjustment_requests` table.** A pending request is a row in a new table
  with its own lifecycle; approving it inserts an `inventory_transactions` row the
  ordinary way. **Recommended.**
- **A2 — a `status` column on `inventory_transactions`**, with every stock query
  filtering `WHERE status = 'approved'`.

A2 is cheaper by one table and wrong on four counts, three of which are things this
project has written down as rules:

1. **It breaks BR-051.** A recorded transaction would change after creation. BR-051 is
   not a preference; `domain-model.md` §8 uses this exact table as *the worked example*
   of the immutable case, and `InventoryTransaction`'s own entity comment points at the
   absence of `UpdateDateColumn` as the consequence. A2 would need to add one.
2. **It puts things that did not happen into the record of what happened.** A pending
   adjustment is a proposal. The history screen, the product history panel, and the
   supplier panel all read that table and would need a filter, and any that missed it
   would show a movement that never occurred.
3. **Every existing stock read acquires a predicate.** `getCurrentStock`,
   `getCurrentStockMap`, `getCurrentStockLocked`, `countSince`, `listAll`,
   `listForProduct`, plus `ProductsService`'s low/out computation. Missing one is a
   silent wrong number — the exact failure class Phases 9, 10 and 11 each spent a
   section refusing.
4. **It disturbs Phase 11's index.** `IDX_inventory_transactions_occurred_at_id` is one
   phase old and sized for the reads as they are.

A1 costs a table and a module and touches **none** of the above: `inventory_transactions`
gets no new column, no new constraint, and no new index; BR-040, BR-042, and BR-051 say
exactly what they said before; and the Phase 11 reads are byte-for-byte untouched. **The
whole of this phase's storage change is one new table.**

### The delta is computed at approval time, not at request time

`CreateAdjustmentDto` carries `newQuantity` — the new *counted total*, not a delta
(Q-UI-2, and its DTO comment explains why). That choice, made for stocktake ergonomics
in Phase 1, turns out to be load-bearing here, and it is worth saying so because it is
the kind of thing a later refactor could undo without noticing:

**A stored delta would go stale; a stored counted total does not.** If Staff count 40
units on Monday and an Owner approves on Wednesday, and a stock-out of 3 happened
Tuesday, then a stored delta of `+5` would be wrong by Wednesday while "the count was
40" is still exactly what was observed. So `adjustment_requests` stores `newQuantity`,
and `quantity_delta` is computed **at approval, under the same pessimistic row lock
`recordAdjustment` already takes** (`docs/learning-notes/database-transactions.md`).

Three consequences, each of which needs an answer rather than a shrug:

- **The Owner's screen must show the delta as of now**, recomputed on load, not a number
  captured at request time. It also shows the counted total and the stock the requester
  saw, because "you counted 40 when the system said 35; it now says 32" is the
  information an approver actually needs.
- **The zero-delta case can arrive by drift.** If stock already equals `newQuantity` at
  approval time, approving would insert a `quantity_delta = 0` row, which the table's own
  `@Check("quantity_delta" <> 0)` forbids and which BR-030 makes meaningless. Approval
  returns **`409`** with the count-now-matches message (the same wording
  `recordAdjustment` already uses for the immediate path), and the Owner rejects the
  request. **No `superseded` status is invented for this** — it is a rejection with an
  obvious reason, and a fifth status would exist to describe one `if` branch.
- **BR-052 is not re-checked at approval.** `occurredAt` was validated when the request
  was submitted and a past date does not become a future one. Stated so that a reader
  does not mistake the absence for an oversight.

### Who may do what to a request

Four rules, and the third is the one with a trap in it:

- **Submit**: any authenticated user, either role — unchanged from BR-072. A Staff
  submission creates a pending request; an Owner submission records the transaction
  immediately, exactly as today.
- **Approve**: Owner only.
- **No self-approval.** The approver must not be the requester. This cannot normally
  arise (an Owner's adjustment never becomes a pending request), but it arises the
  moment a Staff member with a pending request is promoted to Owner (`PATCH /users/:id`,
  FR-063) — the gate would otherwise evaporate retroactively for that request.
  **The stranding case is real and is answered by the next rule**: if the promoted
  requester is the only active Owner, nobody can approve their request. They can
  withdraw it and re-submit, which now goes through the Owner path and is recorded
  immediately. That is the correct outcome — they *are* the authority now — and it is
  reached without a special case in the approval code.
- **Withdraw**: the requester, and only while pending. Reject: Owner, and only while
  pending. A resolved request is terminal; there is no un-reject, no re-open, and no
  edit. A superseded count is a new request, in the same spirit as BR-051's "corrections
  are a new transaction, never an edit."

### Four statuses, because withdrawal is a different fact from rejection

`pending`, `approved`, `rejected`, `withdrawn`. The tempting economy is three, folding a
withdrawal into a self-rejection, and it is rejected for the reason BR-082 gives for
keeping **actor** and **subject** as two columns rather than one: *"I changed my mind
about my own count"* and *"the Owner did not accept this count"* are different facts, and
a screen that shows them as the same one is a screen that cannot answer the question
anyone opens it to ask. The cost is one more enum value.

A resolution carries a mandatory `resolution_reason` on reject and withdraw, and an
optional one on approve. Mandatory-on-reject mirrors BR-032's mandatory adjustment
reason and for the same reason: the decision is the thing being recorded, and a
rejection with no reason tells the requester nothing.

### The new list read is bounded on arrival, using Phase 11's convention unchanged

`GET /adjustment-requests` is a **log by Phase 11's stronger test** — "a read whose
result size is a function of how long the business has been running is unbounded" — not
a catalogue: the pending set is small, but the resolved set grows with the business
forever. So it ships bounded on day one:

- `limit`, `@Min(1)`, `@Max(500)`, default 100 as a module constant in the service, per
  Phase 11 §1 "Configuration or constants".
- `X-Result-Truncated: true` when more matched, absent otherwise, via the existing
  `trimToLimit` / `RESULT_TRUNCATED_HEADER` in `common/result-truncated.header.ts` —
  **reused, not re-derived**.
- Ordered `created_at DESC, id DESC`. The `id` tie-break is *not* load-bearing here the
  way it is on `occurred_at` (`created_at` is a server-set instant, not a date-only
  value, so ties are vanishingly rare) — it is included anyway so that all four bounded
  reads in the API spell the rule the same way, and the entity comment says exactly that
  so the next reader does not conclude the two cases are identical.
- `?days=N` uses **`daysCutoffForInstantColumn`**, not `daysCutoffForDateColumn` —
  `created_at` is a real instant, so it takes the same branch `/audit-events` takes.
  Phase 11 built two functions precisely because one formula is provably wrong for one
  of the two column kinds; this is the first phase since to pick between them, and
  picking the wrong one would be invisible on this machine (UTC+7, where they agree).

That this phase applies the whole convention without re-deriving any part of it is worth
one line in `architecture-observations.md`: Phase 11's stated goal was that the *next*
list read would be bounded by default, and this is the test of it.

### A new module, deliberately outside `InventoryModule`

`architecture-observations.md` has said since Phase 2 that `InventoryService` is the one
piece of this codebase doing real concurrency-sensitive domain logic, that
`InventoryModule` depends on nothing else, and that this is "exactly the seam a future
extraction would need." Putting an approval workflow inside `InventoryService` would put
a policy concern inside that seam and make the hypothetical extraction strictly harder.

So: **`AdjustmentsModule` imports `InventoryModule`**, never the reverse. It owns the
new entity, the new controller, and the workflow; `InventoryService` gains exactly one
new public method (`applyApprovedAdjustment`, §2) and loses none. The dependency arrow
points the same direction `ProductsModule` and `DashboardModule` already point, so the
"`InventoryModule` depends on nothing" property in that file stays true.

One consequence to state plainly because it looks like a mistake in a diff:
**`POST /products/:id/adjustments` moves from `InventoryController` to
`AdjustmentsController`.** The path is unchanged — Nest routes by decorator, not by
module — and moving the handler is what keeps the dependency arrow correct. A reviewer
scanning `InventoryController` for the adjustment route and not finding it should find
this paragraph.

### The Staff path returns `202`, and the Owner path is byte-identical

`POST /products/:id/adjustments` keeps its path, its body, and its validation. What it
returns depends on which path it took:

| Caller | Status | Body | Change |
|---|---|---|---|
| Owner | `201` | `InventoryTransaction` | **none** |
| Staff | `202` | `AdjustmentRequest` | new |

`202 Accepted` is the honest code: the request was accepted and has not been acted on.
The alternative — always returning an `AdjustmentRequest` wrapper with an embedded
transaction when approved — was considered and rejected because it changes the Owner
path's response shape for no benefit, breaking existing e2e assertions and the frontend's
success step to make two dissimilar outcomes look alike. Branching on the status code is
one `if` in `Store.recordAdjustment`.

This is the **second visible response change since Phase 6** (Phase 11 was the first),
and like Phase 11's it is the point of the phase rather than a side effect, so it is
stated here rather than discovered in §5.

### Fork B — one status route, or three action routes. Recommended: one status route

`PATCH /adjustment-requests/:id/status` with `{ status, reason? }`, versus
`POST /adjustment-requests/:id/approve|reject|withdraw`.

The action routes read better in isolation and make the role gate per-route rather than
per-branch. They lose on consistency: this codebase already spells "change the lifecycle
state of a thing" as a status PATCH three times — `PATCH /products/:id/status`,
`PATCH /suppliers/:id/status`, `PATCH /users/:id/status` — each with a
`Set…StatusDto`. A fourth spelling of an existing idea is the kind of drift Phase 11
refused when it added `@Min(1)` to `days` rather than leave two spellings of one rule in
the codebase.

The honest cost, recorded rather than glossed: **this PATCH has a side effect no other
status PATCH has** — approving inserts a row into `inventory_transactions`. The route's
own comment says so, and the response carries the created transaction so the caller does
not have to guess whether one appeared.

### Fork C — record approvals in the audit log, or let the new table be the record. Recommended: the table

`audit_events` (BR-082) records administrative writes; an approval decision looks
administrative, so adding `adjustment_requested` / `adjustment_approved` /
`adjustment_rejected` to the closed list is the reviewer's first instinct.

**Declined**, on BR-083's reasoning applied to a new table rather than a new argument:
`adjustment_requests` already records requester, approver, both timestamps, the outcome,
and the resolution reason. Writing the same facts into `audit_events` would be a second
record of one fact that can drift — the exact objection BR-083 raises against
duplicating stock movements — and it would put the app's highest-frequency workflow into
the low-frequency table Phase 9 §1 built for administrative rarities.

Where this would be revisited, concretely: if the audit screen ever becomes the single
place an Owner is expected to reconstruct "everything that happened," a **read-side
union** across the two tables is the answer (the shape Phase 9 §7 already named for the
unified-activity-feed idea), never a second write.

### No new column on `inventory_transactions`, and no approval provenance in the history reads

A transaction born from an approved request could carry `adjustment_request_id`, letting
the history screen show "approved by Alex". It does not, in this phase. The link is on
the **request** (`resulting_transaction_id`, set once at approval), so:

- `inventory_transactions` is untouched — no column, no constraint, no index, no
  migration against it, and Phase 11's bounded reads keep exactly the query plan they
  were given one phase ago.
- The Approvals screen answers "who approved what" completely. The History screen does
  not, and does not pretend to.

Showing approval provenance in the transaction history means adding a join to the
hottest read in the app to display a field that is `null` on the overwhelming majority
of rows. Deferred with its trigger in §7.

### New FR, new BRs — and BR-072 amended rather than quietly contradicted

- **New FR-066** ("Submit, approve, or reject a stock adjustment"), **Should**, on the
  same reasoning as FR-063, FR-064, and FR-065: an Owner opening a screen to do a job is
  a capability with a route, a UI, and a person behind it. Not **Must** — `product.md`
  §7's MVP list does not contain it, and the system is fully functional without it.
- **New BR-085–089** (§4), covering the gate, the approval-time delta, the actor rules,
  the terminal states, and the product-deletion interaction.
- **BR-072 is amended, not overridden.** It currently reads "Recording a stock-in,
  stock-out, or adjustment requires only an authenticated user, of either role. This is
  **not** a resolution of Q-6." Both halves change: either role may still *initiate* all
  three, but a Staff-initiated adjustment does not become a transaction without an
  Owner's approval — and Q-6 is now resolved. The amendment is written into BR-072
  itself with its date, the way BR-073 was amended by BR-074 in Phase 6, rather than
  left for a reader to reconcile two rules that disagree.

---

## 2. What's new (backend)

### No new dependency

One migration, one entity, one enum, one module, one controller, one service, three
DTOs, one new public method on `InventoryService`, one route relocated, one guard rule.
No new npm package, no new infrastructure, no scheduler, no mail transport (BR-078 still
holds, as in Phases 6, 8 and 9).

### Migration `1787920000000-AddAdjustmentRequests.ts`

Sorting after `1787830000000-AddInventoryTransactionsOccurredAtIndex`.

```
up:
  CREATE TYPE "adjustment_requests_status_enum" AS ENUM
    ('pending','approved','rejected','withdrawn');

  CREATE TABLE "adjustment_requests" (
    "id"                     SERIAL PRIMARY KEY,
    "product_id"             INT  NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
    "new_quantity"           INT  NOT NULL CHECK ("new_quantity" >= 0),
    "occurred_at"            TIMESTAMPTZ NOT NULL,
    "reason"                 TEXT NOT NULL CHECK ("reason" <> ''),
    "status"                 "adjustment_requests_status_enum" NOT NULL DEFAULT 'pending',
    "requested_by_user_id"   INT  NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "stock_at_request"       INT  NOT NULL,
    "resolved_by_user_id"    INT  NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "resolution_reason"      TEXT NULL,
    "resulting_transaction_id" INT NULL REFERENCES "inventory_transactions"("id") ON DELETE RESTRICT,
    "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "CHK_adjustment_requests_resolution" CHECK (
      ("status" = 'pending'  AND "resolved_by_user_id" IS NULL
                             AND "resulting_transaction_id" IS NULL)
      OR ("status" = 'approved' AND "resolved_by_user_id" IS NOT NULL
                                AND "resulting_transaction_id" IS NOT NULL)
      OR ("status" IN ('rejected','withdrawn')
            AND "resolved_by_user_id" IS NOT NULL
            AND "resulting_transaction_id" IS NULL
            AND "resolution_reason" IS NOT NULL AND "resolution_reason" <> '')
    )
  );

  CREATE INDEX "IDX_adjustment_requests_created_at_id"
    ON "adjustment_requests" ("created_at" DESC, "id" DESC);
  CREATE INDEX "IDX_adjustment_requests_status"
    ON "adjustment_requests" ("status");

down: DROP TABLE, DROP TYPE  (additive; nothing to lose)
```

Notes on choices a reviewer will check:

- **Every timestamp is `timestamptz`.** `domain-model.md` §8 says the convention names a
  type as of Phase 10, and this is the first table created since that became true.
  `created_at` **and** `updated_at`, because these rows are mutable — this is the fourth
  mutable table, not a third instance of the immutable case (`inventory_transactions`,
  `audit_events`).
- **`CHK_adjustment_requests_resolution`** encodes the state machine in the schema, in
  the same spirit as `inventory_transactions`' three `@Check`es: a bug or a direct SQL
  script cannot produce an approved request with no approver, or a rejection with no
  reason.
- **`stock_at_request`** is captured at submission and never updated. It is not used to
  compute anything — the delta is computed at approval (§1) — it exists so the approver
  can see what the requester saw. Writing that down here prevents a later reader from
  "fixing" the delta computation to use it.
- **`resulting_transaction_id` is a real FK with `RESTRICT`**, safe for the same reason
  BR-082's audit FKs are: `inventory_transactions` rows are never deleted (BR-051).
  Contrast `audit_events.entity_id`, which deliberately is *not* a foreign key.
- **`IDX_adjustment_requests_status`** exists because the pending queue —
  `WHERE status = 'pending'` — is the screen an Owner opens, and it is the one filter
  with a strongly skewed distribution. This is the only index added on speculation-free
  grounds; Phase 11 §7's "indexing anything else" caution applies to everything not
  listed here.
- **Three registries, again.** The migration covers `smart_inventory` and
  `smart_inventory_e2e`; the entity declaration covers `smart_inventory_test`
  (`synchronize: true`). Phases 9, 10 and 11 each hit this; the same
  `@Index(['createdAt','id'])`-cannot-express-`DESC` caveat Phase 11 documented applies
  verbatim and gets the same one-line entity comment.

### `AdjustmentRequest` entity, `AdjustmentRequestStatus` enum

`backend/src/adjustments/adjustment-request.entity.ts` and
`backend/src/common/enums/adjustment-request-status.enum.ts` — snake_case values,
matching `TransactionType`, `UserRole`, and `AuditEventType`.

`product`, `requestedBy`, `resolvedBy`, and `resultingTransaction` are `ManyToOne`
relations; the list read joins the first three (the same joined-read choice
`/inventory-transactions` and `/audit-events` both make, so no screen needs a second
request for a name).

### `AdjustmentsService`

| Method | Behaviour |
|---|---|
| `submit(productId, dto, user)` | Owner → `inventoryService.recordAdjustment(...)`, unchanged, returns the transaction. Staff → validates the product exists, snapshots `stockAtRequest`, inserts a `pending` row, returns it. |
| `list(query)` | Bounded read (§1), `{ rows, truncated }` via `trimToLimit`. |
| `resolve(id, dto, user)` | The state machine. `404` unknown; `409` if not pending; `403` on self-approval or on a non-requester withdrawing; approval delegates to `InventoryService`. |

`resolve`'s approval branch is the only place the two modules meet, and it must be one
database transaction: insert the `inventory_transactions` row **and** flip the request to
`approved` with its `resulting_transaction_id`, or neither. A crash between the two
would leave a stock movement nobody approved (or a request pointing at nothing), which
is the failure this phase exists to prevent, arriving through the back door.

### `InventoryService.applyApprovedAdjustment(manager, { productId, newQuantity, occurredAt, userId, reason })`

The one new public method. It is `recordAdjustment`'s body with two differences: it takes
an `EntityManager` from the caller rather than opening its own transaction (so the
request update joins it), and it takes the acting user id explicitly (the transaction is
attributed to the **requester**, not the approver — the person who counted the stock is
the person who recorded the movement; the approver is recorded on the request).

`recordAdjustment` is refactored to call it, so the immediate path and the approved path
share one implementation of the lock, the delta computation, the zero-delta check, and
the insert. Two code paths that must produce identical rows should not be two pieces of
code.

**Attribution is a decision, not a detail**, and it is the one place a reasonable person
would choose differently. FR-061 says every transaction records "which user performed
it." The requester performed the count and typed the number; the approver permitted it.
Recording the approver would make `inventory_transactions.recorded_by_user_id` mean two
different things depending on which path a row came from, and would lose the requester
entirely from the ledger. The approver is not lost — the request row names them, and the
request is reachable from the transaction by `resulting_transaction_id`.

### `AdjustmentsController`

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/products/:id/adjustments` | either | **Relocated** from `InventoryController` (§1). `201` + transaction for Owner, `202` + request for Staff. |
| GET | `/adjustment-requests` | either | `?status=&productId=&days=&limit=`. Bounded; `X-Result-Truncated`. |
| PATCH | `/adjustment-requests/:id/status` | either, gated in the service | `{ status, reason? }`. Approve/reject are Owner-only; withdraw is requester-only. |

The role gate on `PATCH …/status` is **in the service, not on `RolesGuard`**, because
legality depends on the actor's relationship to the row (requester vs. not), which a
guard reading only the token cannot know. This is the first route in the app whose
authorization is not fully expressible as `@Roles(...)`, and that is worth its own
sentence in `docs/learning-notes/authentication-and-guards.md` rather than a silent
precedent.

### DTOs

- `SetAdjustmentRequestStatusDto` — `status` (`@IsEnum`, and **not** `pending`:
  a request cannot be moved back), `reason` (`@IsOptional`, `@IsString`; required for
  `rejected`/`withdrawn`, checked in the service where the status is known).
- `QueryAdjustmentRequestsDto` — `status?`, `productId?`, `days?` (`@Min(1)`),
  `limit?` (`@Min(1) @Max(500)`), copied from `QueryTransactionsDto` decorator for
  decorator, per Phase 11 §1.
- `CreateAdjustmentDto` — **unchanged.** Same three fields, same validation, same
  comment. Worth listing as a no-change because a reader will look.

### `ProductsService.remove` — one new check

BR-004 blocks deleting a product with transaction history. A product with **no**
transactions but a **pending** request is currently deletable, and the `RESTRICT` FK
would turn that into a database error surfacing as a `500`. It gains an explicit check
producing the documented `409`, with a message naming the pending request, mirroring
BR-004's existing message. Small, and included because the alternative is a `500` on a
path a user can reach.

### `run-seed.ts`, `configuration.ts`, `.env.example` — no change

Consistent with Phases 7 through 11. Seeding writes rows directly through repositories
and emits no audit events (README's existing note); it likewise creates no adjustment
requests, and a seeded pending request would attribute a decision to a person who never
made one — the same argument the empty-audit-log note already makes.

---

## 3. Frontend changes

**1. The transaction wizard's Adjustment path gains a second outcome.** `Views.transactionWizard`'s
review step currently ends in "recorded." For a Staff user it now ends in *"Sent for
approval — an Owner will review this count."* `Store.recordAdjustment` branches on the
response status (`201` vs `202`) and returns a discriminated result; the wizard's success
step renders one of two panels. The Owner path's wording does not change.

**2. A new Owner-only nav item and screen, `#/approvals`.** Modeled on `#/audit`
(Owner-only route, guarded by the existing `isOwnerOnlyRoute` mechanism in `renderApp()`,
same nav treatment): a list of requests with a `status` filter defaulting to `pending`,
each row showing product, counted quantity, the stock the requester saw, **the delta as
of now**, requester, and age. Approve and Reject are row actions; Reject opens a small
reason prompt because the reason is mandatory (§1).

**3. Staff see their own requests, on the same screen, read-only.** The route is *not*
Owner-only for reading — BR-073 keeps reads open to both roles, and a Staff member who
submitted a count needs to know whether it was accepted. Staff see the list without the
Approve/Reject actions, plus a Withdraw action on their own pending rows. This is the
first screen in the app that is visible to both roles with a different action set, which
is a UI pattern the Products screen already establishes at the button level (Phase 5's
"seeing fewer buttons than Alex sees is expected, not a bug").

**4. A pending count badge on the Approvals nav item, for Owners.** Deliberately **not**
a dashboard tile. `GET /dashboard/summary` composes from FR-004, FR-031 and FR-042 and
nothing else (BR-062), and Phase 9 §7 declined an audit-derived dashboard tile for
exactly that reason. A nav badge is chrome, not dashboard data, and needs no change to
the dashboard route or `DashboardService`.

**5. The truncation notice, reused.** The Approvals list is bounded (§1), so it renders
`UI.truncationNotice(...)` on `X-Result-Truncated` like the four screens that already do,
with a hint pointing at its own filters. `Store.listAdjustmentRequests` returns
`{ items, truncated }` in the shape the four existing bounded reads already return —
the fifth caller of a pattern Phase 11 built for exactly this.

**Explicitly not in this phase's frontend:** an approvals inbox with unread state, email
or in-app notifications, bulk approve, an approval comment thread, or any change to the
Inventory History screen (which continues to show transactions, not requests).

---

## 4. Documentation updates

1. **`product.md`** — the phase's largest documentation change, and the one that needs
   the owner's eye:
   - §5 gains a use case: *"Staff record a stocktake correction; an Owner reviews and
     approves it before stock changes."*
   - §7's Future list line is rewritten: **general** approval workflows stay Future;
     adjustment approval is removed from that line and is now shipped. §7's Should Have
     list gains it.
   - §10 **Q-6 marked Resolved 2026-09-03, Phase 12**, with the answer stated in the
     entry itself (approval for Staff-initiated adjustments; Owner adjustments
     immediate) rather than only by reference — the way Q-5 and Q-8 were resolved.
   - §11 gains a Phase 12 cross-reference in the register of Phase 9's, not Phase 7/10/11's:
     this phase does change §4, §5, §7 and §10. Q-4 and Q-7 remain open.
   - §9 **A-5 is amended** — it currently says Staff "can perform every inventory
     operation … the same as Owner," which stops being true for adjustments.

2. **`requirements.md`** — **FR-066** added (Should, Done), with the FR-063/064/065
   "operability, not MVP correctness" reasoning spelled out for a fourth time, plus the
   distinguishing note that unlike those three this one *changes an existing rule's
   behaviour* rather than adding beside it. FR-022's Notes column gains a pointer to
   FR-066 and BR-085. FR-062's row gains a line that role now gates an outcome, not only
   a route.

3. **`business-rules.md`** — **BR-072 amended** (§1), and five new rules:
   - **BR-085** — a Staff-initiated adjustment is a request and changes no stock until
     an Owner approves it; an Owner-initiated adjustment is recorded immediately.
   - **BR-086** — the delta is computed at approval time against current stock under
     lock, not at request time; a request that has become a no-op cannot be approved.
   - **BR-087** — no self-approval; withdrawal is the requester's own act; approve and
     reject are the Owner's; a resolved request is terminal.
   - **BR-088** — an approved adjustment's transaction is attributed to the **requester**
     (FR-061); the approver is recorded on the request.
   - **BR-089** — a product with a pending request cannot be deleted, extending BR-004's
     principle to a row that is not yet history.
   - Plus one line recording that **no new `AuditEventType` is added** and why
     (Fork C) — the counterpart to Phases 10 and 11's "no new BR" lines.

4. **`domain-model.md`** — the first new entity since Phase 9:
   - §3's evaluated-entities table gains **Adjustment Request — Yes, as supporting**,
     with the rationale that the core domain functions identically without it (the same
     framing Audit Event got).
   - §4 gains an "Adjustment Request" responsibilities entry, drawing the distinction
     this phase turns on: **a request is a proposal about the future; a transaction is a
     record of the past.**
   - §5's relationship block gains `Product 1 ── * Adjustment Request`,
     `User 1 ── * Adjustment Request (requested by / resolved by)`, and
     `Adjustment Request 0..1 ── 1 Inventory Transaction`.
   - §6 gains an invariant: a pending request contributes nothing to current stock.
   - §8 records the new table as the **fourth mutable table** (`created_at` +
     `updated_at`), contrasted with the two immutable ones.

5. **`api.md`** — title bumped to Phase 12. A new "Adjustment Requests" section; the
   changed `POST /products/:id/adjustments` row with **both** outcomes and their status
   codes stated explicitly; `X-Result-Truncated` extended from three routes to four (the
   sentence that currently says "exactly those three routes and no others" is now false
   and must be edited, not appended to); and the `?days=N` calendar contract noted as
   applying to the new route by the instant-column cutoff.

6. **`architecture-observations.md`** — two entries, both of which are the file's actual
   currency rather than a summary of this plan:
   - **The module seam held.** Phase 2 named `InventoryModule`'s zero dependencies as
     the seam a Go extraction would use. The first genuinely new concern to arrive since
     then that *could* have been dropped into `InventoryService` was put in a module
     that depends on it instead, and the arrow still points one way. That is one data
     point that the seam is real rather than incidental.
   - **Phase 11's convention was reused without re-derivation.** The bound, the header,
     the ordering rule, and the correct one of the two `days` cutoffs were all applied by
     reference. Phase 11 §1's implicit claim was that writing the decision down once
     would make the next list read cheap; this is the first evidence either way, and it
     is worth recording as such rather than assuming.
   - Also: the three named unenforced preconditions in that file are **unchanged in
     number** by this phase, which is worth a clause since a reader will check.

7. **`README.md`** — Current phase updated, plus one operational note in the register of
   the Riley, lockout, empty-audit-log and truncated-history ones: **signing in as Jordan
   or Sam and recording an adjustment produces "Sent for approval," not a stock change —
   that is the feature, not a failed write.** Plus the
   `migration:run`-against-both-databases reminder, since this phase ships a migration.

8. **`docs/learning-notes/authentication-and-guards.md`** — extended, not a new note:
   the first authorization rule in this app that `@Roles()` cannot express, because it
   depends on the actor's relationship to the row rather than only on the token. The
   generalizable lesson in that file's currency: **role-based and ownership-based
   authorization are different mechanisms, and a guard that only sees the request cannot
   implement the second.**

9. **`docs/learning-notes/database-transactions.md`** — extended: the approval path is
   the codebase's first transaction spanning two modules' repositories, and the reason
   `applyApprovedAdjustment` takes an injected `EntityManager` rather than opening its
   own.

10. **`docs/ui-open-questions.md`** — Q-UI-2 gains a note: the "new counted quantity"
    choice, made for stocktake ergonomics in Phase 1, is what makes a request survive a
    delay without going stale (§1). Q-UI-1 (adjustments allowed on inactive products) is
    unchanged and explicitly still holds for requests.

---

## 5. Testing plan

The shape here is different from Phase 11's again. Phase 11's problem was that its
existing suite would break loudly in places unrelated to the change. This phase's
problem is that **most of the new behaviour is a state machine, and state machines fail
at their edges**, so the tests are mostly transitions rather than values.

- **Unit — `adjustments.service.spec.ts`** (new). The full transition matrix, with
  mocked repositories: every `(current status × requested status × actor relationship)`
  cell, asserting the allowed ones succeed and the rest produce the documented `403` or
  `409`. Specifically including the two that are easy to get wrong: **an Owner approving
  their own promoted-from-Staff request → `403`**, and **a resolved request being
  resolved again → `409`, not a silent second approval**.

- **Integration — `adjustments.service.integration.spec.ts`** (new; real Postgres, the
  way `inventory.service.integration.spec.ts` already is):
  - **The headline test: approval computes the delta against stock as of approval, not
    as of request.** Submit a request for `newQuantity = 40` when stock is 35; record a
    stock-out of 3; approve; assert the inserted transaction's `quantityDelta` is `+8`
    and final stock is exactly 40. **Verified the way Phase 11 verified its tie-break:**
    by changing the implementation to use a request-time delta and confirming the
    assertion goes red. A test that passes on both trees proves nothing (Phase 10 §5's
    lesson, applied before rather than after).
  - **Atomicity.** Force the request update to fail after the transaction insert;
    assert **no** `inventory_transactions` row survives and the request is still
    `pending`. This is the one failure mode that would silently produce the exact thing
    the phase prevents.
  - **Concurrent approval of two requests on one product**, in the spirit of the
    existing concurrent stock-out test: both approve, neither corrupts stock, and the
    second one's delta reflects the first one's effect.
  - **Zero-delta by drift** → `409`, and the request stays `pending`.
  - **The bounded read**, exactly the four cases Phase 11 established: no `limit`
    returns 100 of 150; `limit: 500` returns 150; `limit: 150` returns 150 **without**
    the flag; `limit: 149` returns 149 **with** it.
  - **`?days=N` uses the instant-column cutoff**, asserted at four different hours, red
    against `daysCutoffForDateColumn`.

- **E2E — `adjustments.e2e-spec.ts`** (new; the seventh spec):
  - Staff `POST /products/:id/adjustments` → `202`, body is a request, **stock unchanged**
    (asserted through `GET /products/:id`, not by reading the new table — the point is
    what a client observes).
  - Owner `POST` → `201`, body is a transaction, stock changed. Byte-compatible with the
    pre-phase assertions.
  - Approve → stock changes, `resulting_transaction_id` set, the transaction appears in
    `GET /inventory-transactions` attributed to the **requester** (BR-088).
  - Reject with no reason → `400`; reject with a reason → `409` on a second attempt.
  - Staff `PATCH …/status {approved}` → `403`. Staff withdrawing someone else's → `403`.
  - `X-Result-Truncated` present when it should be and **absent — not `false`** — when
    it should not, matching the contract `api.md` documents for the other three routes.
  - `DELETE /products/:id` with a pending request → `409` (BR-089), and the message
    names the pending request rather than leaking a constraint name.

- **Existing suites — where breakage is expected rather than a regression.** The rule is
  Phase 11 §5's and it is not "adjust the number until green":
  - `roles.e2e-spec.ts` asserts a Staff user may record an adjustment. That assertion is
    now about a `202` and a pending request, and it must be **rewritten to state the new
    rule**, with a comment naming BR-072's amendment — not deleted, and not silently
    renumbered to `202`.
  - `app.e2e-spec.ts` and `inventory.service.integration.spec.ts` seed adjustments; any
    seeded as a Staff user now produce no stock change. Each is classified before it is
    edited: *testing the adjustment mechanism* (→ seed as Owner, comment why) or
    *testing the approval flow* (→ move to the new spec).
  - `dashboard.service.spec.ts` is untouched. The dashboard reads transactions, and a
    pending request is not one — asserted rather than assumed, with one case where a
    pending request exists and `transactionsLast7Days` does not move.

- **No new unit test for the DTOs**, per Phase 10 and 11's call: `@IsEnum`/`@Min`/`@Max`
  is `class-validator`'s behaviour, and the e2e `400` cases prove the wiring end to end.

---

## 6. Rollout order

1. **The migration and the entity, alone, against `smart_inventory`.** No service, no
   route, no frontend. The table exists and nothing reads or writes it — individually
   shippable, changes no behaviour, nothing to revert if a later step goes wrong. Same
   de-risking arrangement Phases 8 through 11 each put first.
2. **`npm run migration:run` against `smart_inventory_e2e`.** Its own step, for the
   reason Phase 10 §2 named and Phase 11 repeated: it is the database that gets
   forgotten, and forgetting it looks like success.
3. **`InventoryService.applyApprovedAdjustment` extracted, `recordAdjustment` refactored
   to call it — no behaviour change.** Landing this alone means that if the existing
   inventory suite moves, the cause is unambiguous. This is the step that must not be
   skipped if the phase is cut short.
4. **`AdjustmentsModule`, service, controller, DTOs; the route relocated.** Owner path
   still `201` + transaction; Staff path now `202` + request. The behaviour change.
5. **`ProductsService.remove`'s pending-request check** (BR-089). After step 4, so the
   `409` has something to detect.
6. **The frontend** (§3) — the wizard's second outcome first, then the Approvals screen,
   then the nav badge. The wizard first because after step 4 a Staff adjustment silently
   appears to do nothing, and that is the worst state to leave the app in.
7. **The new and adjusted tests** (§5) — the approval-time-delta integration test last
   among the code steps, for Phase 10 and 11's shared reason: it is the test that can
   fail *for the right reason*, so running it against an otherwise-green tree means a
   red result points at the phase's subject rather than at its plumbing.
8. **Documentation** (§4). As in every phase in this series, these outlast the code and
   are not optional in any cut.

If this phase is cut short, the coherent stopping point is **after step 3**: the
extraction is done, every response is exactly what it was before, and the table sits
unused. **Stopping between steps 4 and 6 is the genuinely bad place**, because the
backend defers a Staff adjustment and the frontend says "recorded" — a person's stocktake
correction disappearing with a success message, which is the wrong-data-that-looks-right
failure this project has refused in three consecutive phases.

---

## 7. Explicitly out of scope for Phase 12 (Future)

- **Approval on any other write.** Stock-in, stock-out, product/supplier/category
  changes, and user administration are untouched. `product.md` §7 keeps general approval
  workflows Future; this phase resolves Q-6 and nothing adjacent to it.
- **A magnitude threshold ("only adjustments over N units need approval")** — Fork 0.
  **Its trigger is concrete**, in the manner of Phase 9 §7's retention policy and Phase
  11 §7's catalogue paging: when an Owner says the queue is mostly noise, the answer is a
  threshold in `AdjustmentsService.submit`'s branch, plus a `configuration.ts` entry, not
  a rule engine.
- **Notifying an Owner that something is pending** — no email, no SMS, no push, no
  in-app toast. There is still no mail transport in this project (BR-078), exactly as
  Phases 6, 8, 9 and 10 each recorded. The nav badge is the whole notification, and it
  only appears when the Owner is already looking at the app.
- **An SLA, escalation, auto-approval on timeout, or reminders** — every one of them
  needs a scheduler, and this project has none; Phase 9 §7 declined a retention policy
  for the same reason. A request that nobody looks at stays pending forever, visibly.
- **Approval provenance in the transaction history reads** (§1) — the `resulting_transaction_id`
  link exists and only the Approvals screen uses it. **Trigger**: when someone asks "who
  approved *this* movement" while looking at the history screen, the answer is a join
  added deliberately to that read, sized against Phase 11's index, not a column bolted
  onto `inventory_transactions`.
- **Editing a pending request** — withdraw and re-submit, in the spirit of BR-051. A
  mutable proposal would need its own change history to be trustworthy, which is a
  second audit problem to solve for a screen nobody has asked for.
- **Recording approvals in `audit_events`** — Fork C, declined with its trigger (a
  read-side union, never a second write).
- **A per-request detail route or screen** — the list carries every field the decision
  needs. A `GET /adjustment-requests/:id` would exist only to be symmetrical.
- **Bounding the four catalogue reads** (Phase 11 §7, Fork A) — still parked, still with
  its trigger unfired. Named because this phase adds a **fifth** bounded read and a reader
  will ask whether the balance shifted: it did not, and the reason is unchanged (a
  truncated catalogue is a wrong answer where a truncated log is a reading position).
- **A way past the first 100 rows on the two scoped-history screens** (Phase 11 §7) —
  unchanged, and the Approvals screen deliberately joins them rather than solving it.
- **A retention or pruning policy for `audit_events`** (Phase 9 §7) — still parked, still
  unfired. This phase adds a second table that grows with the business and does not give
  either one a policy.
- **A shared throttle store** (Phase 8 §7) — still parked, still recorded in
  `architecture-observations.md`, still not this phase's problem.
- **Export, tamper-evidence, alerting, or a dashboard tile derived from the audit log**
  (Phase 9 §7) — all unchanged. The nav badge is explicitly *not* the dashboard tile
  Phase 9 declined; see §3 item 4.
- **`last_login`** — still not a column, still the thing `audit_events` already answers.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.
  **Q-6 is not on this list, for the first time since Phase 5.**

---

## 8. Definition of done

- [ ] `product.md` Q-6 is marked **Resolved**, with the answer written in the entry
      itself, and §7's Future line distinguishes general approval workflows (still
      Future) from adjustment approval (shipped). §4, §5, §9's A-5, and §11 all reflect
      the phase. Q-4 and Q-7 are still recorded as open.
- [ ] A Staff `POST /products/:id/adjustments` returns `202` with an `AdjustmentRequest`
      and **changes no stock**, proven through `GET /products/:id` rather than by reading
      the new table.
- [ ] An Owner `POST /products/:id/adjustments` is **unchanged** — `201`, an
      `InventoryTransaction`, immediate stock change — and the pre-phase e2e assertions
      for it pass without edit.
- [ ] `inventory_transactions` has **no new column, no new constraint, and no new
      index**, and Phase 11's two bounded reads execute the same query they did before
      (Fork A's whole claim, asserted by inspection of the migration and by the existing
      Phase 11 specs staying green unedited).
- [ ] The delta is computed **at approval**, under the same pessimistic lock, and the
      integration test proving it **goes red** against a request-time-delta
      implementation — not by inspection, and not by a test that passes on both trees.
- [ ] Approval is **atomic**: a forced failure after the transaction insert leaves no
      `inventory_transactions` row and a still-`pending` request.
- [ ] The state machine is enforced in both the service and the schema: a resolved
      request cannot be resolved again (`409`), an approver cannot be the requester
      (`403`), a rejection without a reason is `400`, and
      `CHK_adjustment_requests_resolution` makes each illegal combination unwritable by
      direct SQL.
- [ ] An approved adjustment's transaction is attributed to the **requester** (BR-088),
      and the approver is recoverable from the request.
- [ ] `GET /adjustment-requests` is bounded on arrival with Phase 11's exact convention —
      `@Min(1)`, `@Max(500)`, default 100 in the service, `X-Result-Truncated` **present
      only when true** — and uses `daysCutoffForInstantColumn`, proven by a test that
      goes red against the date-column function.
- [ ] `IDX_adjustment_requests_created_at_id` and `IDX_adjustment_requests_status` exist
      in **both** `smart_inventory` and `smart_inventory_e2e`, and are declared on the
      entity so `smart_inventory_test` builds them too.
- [ ] `DELETE /products/:id` with a pending request returns the documented `409`
      (BR-089), never a `500` from the foreign key.
- [ ] `AdjustmentsModule` imports `InventoryModule` and **not the reverse** —
      `InventoryModule` still depends on nothing, and
      `architecture-observations.md` records that the Phase 2 seam held its first real
      test.
- [ ] No new `AuditEventType` was added, and `business-rules.md` records that decision
      with its reasoning and its revisit trigger (Fork C).
- [ ] The frontend never tells a Staff user an adjustment was "recorded" when it was
      queued; both history views and the new Approvals list render the shared truncation
      notice; the pending badge is on the nav, **not** on the dashboard (BR-062 intact,
      `DashboardService` unchanged).
- [ ] Every existing spec that changed was classified before it was edited — asserting
      the adjustment *mechanism* (→ seeded as Owner, with a comment) or asserting the
      *approval flow* (→ moved to the new spec). No spec's expected status code was
      adjusted until green.
- [ ] All three scope forks were decided and recorded either way: a new table vs. a
      status column on `inventory_transactions` (Fork A), one status route vs. three
      action routes (Fork B), and audit-log events vs. the new table as the record
      (Fork C) — plus Fork 0, the decision to answer Q-6 at all.
- [ ] `api.md` (Phase 12), `requirements.md` (FR-066), `business-rules.md` (BR-072
      amended, BR-085–089), `domain-model.md` (the first new entity since Phase 9),
      `architecture-observations.md`, `README.md`, `ui-open-questions.md`, and the two
      extended learning notes all reflect the phase.
- [ ] Full backend suite green: unit, integration (including the new cases), and all
      seven e2e specs.
