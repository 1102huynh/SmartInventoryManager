# Phase 11 Plan — Bounded Reads

Status: Phase 11 — Done
Last updated: 2026-08-27
Scope decided with the project owner: **give the two transaction-log reads the bound
Phase 9 already gave `/audit-events`, and fix the two callers that today fetch the whole
table to use eight rows of it** — and nothing else. Scoped the same way
`phase-3-plan.md` was scoped to authentication, `phase-5-plan.md` to authorization,
`phase-6-plan.md` to user management, `phase-7-plan.md` to audit timestamps,
`phase-8-plan.md` to rate limiting and lockout, `phase-9-plan.md` to the audit log, and
`phase-10-plan.md` to `timestamptz`: one headline change, an explicit out-of-scope list,
no punch-list riding along.

## Why this phase, why now

Phase 9 capped exactly one read, and gave one reason for it:

> the cap is not optional here: this table grows without any user doing anything, from
> every failed login anywhere on the internet

That reason is true of `audit_events`. The trouble is that it is the *weaker* of the two
reasons available, and picking it left the stronger one unsaid — so the convention it
created got applied to one table and stopped there. Here is the census, taken from the
repository today rather than from memory:

| Route | Service method | Bound today | Ordered by | What makes it grow |
|---|---|---|---|---|
| `GET /audit-events` | `AuditService.findAll` | `limit`, default 100, `@Max(500)` | `event.id DESC` | every login attempt, anonymous included |
| `GET /inventory-transactions` | `InventoryService.listAll` | **none** | `tx.occurredAt DESC` | **every stock movement, forever** |
| `GET /products/:id/transactions` | `InventoryService.listForProduct` | **none** | `occurredAt DESC` | **every stock movement on that product, forever** |
| `GET /products` | `ProductsService.findAll` | none | `product.name ASC` | an Owner deciding to add a product |
| `GET /suppliers` | `SuppliersService.findAll` | none | `name ASC` | an Owner deciding to add a supplier |
| `GET /categories` | `CategoriesService.findAll` | none | `name ASC` | an Owner deciding to add a category |
| `GET /users` | `UsersService.findAll` | none | `id ASC` | an Owner deciding to add an account |

Two groups, and the line between them is not "how fast does it grow" but **who decides**.
The four catalogue reads grow one row at a time, by a person choosing to add a row, and
they are bounded by that person's willingness to keep typing — `product.md` §3's "1–10
people", A-1's single location, `product.md` §7's "dozens of products". Those bounds are
soft and unenforced, but they are real, and a screen that lists them is *supposed* to
list all of them.

The two transaction reads are in `audit_events`' category, not the catalogue's. Nobody
decides to grow `inventory_transactions`; it grows because the business is open. A
shop recording forty movements a day has fifteen thousand rows in its second year, and
`GET /inventory-transactions` with no query string returns **every one of them, with
three joins**, to render a screen that shows the recent ones. The strongest form of
Phase 9's argument is not "an attacker can grow this table" — it is:

> **A read whose result size is a function of how long the business has been running is
> unbounded, and which mechanism does the growing is irrelevant to that.**

Under that form, `inventory_transactions` qualifies for the same treatment as
`audit_events`, and it qualified on the day Phase 9 shipped. `audit_events` merely made
it *visible*, by being the first table where an adversary rather than a customer supplied
the rows.

Three things make *now* the right time rather than later, and none of them is a hunch:

- **Two callers already pay the full cost, today, in the repository.**
  `DashboardService.getSummary` — the app's entry screen — calls
  `this.inventoryService.listAll({})`, materialising the entire joined transaction
  history, and then `.slice(0, 8)`. It then calls `listAll({ days: 7 })` a *second* time
  and reads nothing off it but `.length`. Opening the dashboard is O(whole history),
  twice, to produce eight rows and one integer. That is not a risk this phase is
  anticipating; it is what the code does.
- **The problem is currently invisible for the one reason that will stop being true.**
  A fresh `npm run seed` produces a handful of transactions, and `smart_inventory_e2e` is
  truncated before every spec. Every environment this project has ever run in has had a
  near-empty transaction table — the same shape of unenforced, untested, never-named
  precondition Phase 10 §1 spent a whole phase deleting from the schema. It stops being
  true by the system being used successfully.
- **The convention to copy already exists and is one phase old.** Phase 9 decided
  `limit`'s floor, its ceiling, where the default lives, and `@Max` over silent clamping,
  with reasons written down in `QueryAuditEventsDto`'s comment. Applying an existing
  decision costs an afternoon; re-deriving it in eighteen months, against a table that has
  by then grown, costs a phase.

---

## 1. Design decisions

### A limit on a non-total order is not a page — it is a lottery

This is the sharpest line in the phase, it is not obvious, and every other decision
below has to accommodate it.

`InventoryService.listAll` orders by `tx.occurredAt DESC` and nothing else.
`listForProduct` orders by `occurredAt DESC` and nothing else. Today that is harmless,
because both return every row and the client sees a complete set in *some* valid order.
**The moment a `LIMIT` is applied, the ordering has to be total, or the rows that survive
the cut are arbitrary.**

And on this table the ordering is emphatically not total. `occurred_at` is the
user-supplied business date (`domain-model.md` §8), and the frontend supplies it from
`<input type="date">` (`frontend/index.html`, the transaction form's `f-date`) — a
date-only string. `InventoryService.insertTransaction` does `new Date(values.occurredAt)`
on it. **Every transaction recorded for the same business day therefore carries a
byte-identical `occurred_at`.** Ties are not an edge case here; they are the normal case,
and a busy day is a tie of forty rows.

`SELECT … ORDER BY occurred_at DESC LIMIT 100` over such a table gives Postgres a free
choice among the tied rows, and Postgres is under no obligation to make the same choice
twice — a plan change, a vacuum, or an index being added is enough to change it. The
concrete failure the user sees: refreshing the history screen shuffles which of today's
movements appear, and a row visible a moment ago is gone with no page to find it on.

**Every ordering that gains a `LIMIT` in this phase gains `id DESC` as a final tie-break.**
`id` is the `PRIMARY KEY`, so the composite order is total by construction, and `id DESC`
also happens to be insertion order within a day — the sensible reading of "most recent"
when the business date can't distinguish two rows.

Worth naming what this says about Phase 9: `AuditService.findAll` orders by
`event.id DESC` alone, which is total, so `/audit-events` never had this problem. That
plan's own text (§1 "Newest first, capped") gives no sign the choice was made *for* this
reason — the ordering column and the cap are discussed separately. **It was right, and
this phase is the first to say why it was right**, which is worth a sentence in
`api.md` rather than leaving the next person to add a `created_at DESC` ordering to that
route and quietly reintroduce the problem there.

### What gets bounded, and the four routes that deliberately do not

**The two transaction reads, and nothing else.** `GET /inventory-transactions` and
`GET /products/:id/transactions` gain `limit`; `/products`, `/suppliers`, `/categories`,
and `/users` do not. Fork A below records the alternative and why it loses, but the short
version belongs here because it is a decision about what this phase *is*:

**A cap on a log is a reading position. A cap on a catalogue is a wrong answer.**
"The most recent 100 movements" is a complete, honest response to "what happened
lately" — a log reader is asking about a window, and the window is the answer. "100 of
your 140 products" is not a response to "what do I stock"; it is the wrong list, in a
shape indistinguishable from the right one. Capping a catalogue honestly needs a total, a
next page, or a rethink of the screen's filters — a product decision about the Product
List, not a storage decision about a read. Phase 10 §7 made the same distinction with
timezones ("a display preference is a product decision about the reader, not a storage
decision about the value") and this is the same cut.

There is a second, purely mechanical reason the catalogue lists cannot take a naive
`LIMIT`, and it would be discovered at exactly the wrong moment:
**`ProductsService.findAll` filters `status=low` and `status=out` in application code,
after the SQL query has already run** — it must, because both depend on current stock,
a computed value the `WHERE` clause cannot see. A `LIMIT` pushed into that query would
take the first N products *by name* and only then filter for low stock, so
`?status=low&limit=50` would return however many of the first 50 alphabetical products
happen to be low — not 50 low-stock products, and not all of them either. The route
would answer a question nobody asked, in a shape that looks like an answer to the one
they did.

### `users.locked_until`-style honesty about what this buys

Unlike Phase 10, this phase **does** change what some responses contain: an
unfiltered `GET /inventory-transactions` against a database with more than 100
transactions returns 100 rows where it used to return all of them. That is a visible
behavior change — the first since Phase 6 — and it is the phase's whole point rather
than a side effect, so it is stated here at the top rather than discovered in §5.

What it buys is not speed on the machine this runs on today (where the whole table fits
in a page of memory and the difference is unmeasurable). It buys a **defined worst case**.
Right now the worst-case response size of `GET /inventory-transactions` is a function of
the calendar, and no line of code anywhere states an upper bound or would notice one
being exceeded. After this phase there is a number, it is in a DTO, and a request for
more than it is a `400` rather than a slow success.

### Truncation has to be observable, or this phase re-creates the defect it is fixing

A cap the caller cannot detect is a value whose meaning depends on unrecorded state —
literally the class of defect Phase 9 (`req.ip` behind a proxy) and Phase 10 (naive
`timestamp`) both named as **wrong data that looks like a real signal**. Shipping a
silent cap here would be that joke at the phase's own expense a third time.

So a capped response says so, and the mechanism is deliberately the cheapest one that
works:

- **Ask the database for `limit + 1` rows, return `limit`.** If the extra row came back,
  more rows exist. No `COUNT(*)`, no second query, no extra join — one integer added to
  the existing `take()`.
- **Report it in a response header, not in the body.** `X-Result-Truncated: true`,
  present only when it is true. Fork B records the envelope alternative
  (`{ items, total, limit }`) and why a header wins here: the envelope changes the shape
  of two routes that four screens and three e2e specs already destructure as bare arrays,
  and this phase does not need a `total` — nothing in the UI displays one, and computing
  one would reintroduce the full-table scan the phase exists to remove.

**`/audit-events` gets the same header, retroactively.** It has been silently truncating
since Phase 9 — the one place where this phase touches something outside its two routes,
and it earns the exception: leaving the older capped route as the only silent one would
mean the convention this phase writes down is false on the day it is written.

### The index Phase 9 added and Phase 2 never did

`audit_events` carries `IDX_audit_events_created_at`, created by
`1787650000000-AddAuditEvents` specifically for the `days` filter.
`inventory_transactions` has exactly one index, on `product_id`
(`IDX_2520d97de0c9a0fbfc9b00f4c1`, `InitSchema`) — **nothing on `occurred_at`**, which is
the column both log reads order by *and* the column `?days=` filters on.

Unindexed, `ORDER BY occurred_at DESC LIMIT 100` is a full scan plus a sort of the whole
table, and adding a `LIMIT` on top of that reduces what crosses the wire without reducing
what Postgres does. So this phase adds one migration creating
`IDX_inventory_transactions_occurred_at_id` on `(occurred_at DESC, id DESC)` — the
composite from §1's first decision, so the index can satisfy the ordering directly and
the top-N read becomes an index scan that stops after 101 rows.

This is a **`CREATE INDEX`, not an `ALTER`** — additive, unlike Phase 10's converting
migration, so `down()` is a plain `DROP INDEX` with nothing to lose. Worth stating
because Phase 10 §1 made a point of being the project's first converting migration, and a
reviewer arriving from that plan will look for the `USING` clause that is correctly not
here.

The index is `CREATE INDEX`, not `CREATE INDEX CONCURRENTLY`. At this project's scale the
lock is milliseconds, and TypeORM runs each migration inside a transaction, which
`CONCURRENTLY` cannot join — buying a non-blocking build would mean special-casing the
migration runner for a table that takes no measurable time to index.

### Configuration or constants: constants, following Phase 9

`AuditService` holds `const DEFAULT_LIMIT = 100` in the file, with `@Max(500)` in the
DTO. This phase copies that exactly — `DEFAULT_LIMIT`/`MAX_LIMIT` as module constants in
`InventoryService`, no `configuration.ts` entry, no `.env.example` line.

The Phase 8 counter-precedent is real and does not apply: `AUTH_LOCKOUT_MINUTES` is
configuration because a deployment might reasonably differ *and* because the e2e suite
must shrink it to make auto-expiry testable at all. Neither holds here. No deployment
tunes a page size, and the tests set `limit` per request through the query string, which
is the mechanism the feature already provides.

### No new FR, no new BR — the fourth and second instances

- **No new FR**, beside the Phase 7, Phase 8, and Phase 10 notes. "How many rows one
  request returns" is not a user goal in `product.md` §4, and no Owner opens a screen to
  do anything with it. FR-030 ("view the chronological list of all … transactions for a
  given product") and FR-031 ("view all inventory transactions") are worth reading
  closely before agreeing to this, because the word **all** appears in both — and the
  honest reading is that they describe *the screen's subject*, not a transport-level
  guarantee about one HTTP response. The requirement is satisfied by a screen that shows
  the history; it was never a promise that one request would carry every row of it. §4
  records this reading explicitly in `requirements.md` rather than leaving it as an
  unstated interpretation, because it is the one place a reader could reasonably say this
  phase broke a Must.
- **No new BR**, the second instance after Phase 10. A result cap is a property of a
  transport, not a rule about the business. BR-050 (what must be recorded), BR-051
  (immutability), and BR-062 (dashboard scope) all say exactly what they said before, and
  nothing about which rows a client receives changes what is true of the rows.

### Two flagged scope forks

**Fork A — bound all six list reads, or only the two transaction logs. Recommended: only
the two** (§1 above).

The case for all six should be stated at its strongest, because it is the tidier answer
and this project's own values push toward it: an unbounded read is an unenforced
precondition ("this business will never have more than N products"), nothing checks it,
nothing would report it failing, and Phase 10 spent an entire phase deleting exactly that
shape of assumption from the schema. Bounding everything would let §8 say the flat,
checkable thing — *no read in this API can return an unbounded number of rows* — instead
of a sentence with an exception in it.

It loses on two counts. First, the mechanical one: `ProductsService.findAll`'s
post-SQL low/out filter (§1) means a `LIMIT` on that route is not merely unhelpful but
*wrong*, and fixing that means moving current-stock computation into SQL — a real change
to the most load-bearing query in the app, in a phase that is supposed to be about
transport. Second, the substantive one: a truncated catalogue is a wrong answer where a
truncated log is a reading position, and the four catalogue routes need a paging *design*
(a total, a next page, a rethink of filters) rather than a ceiling. Doing that badly here,
as a side effect, is precisely the "punch-list riding along" every plan in this series has
refused. It goes on §7 with its trigger named, in the manner of Phase 9 §7's retention
policy.

**Fork B — signal truncation with a response header, or wrap the body in an envelope.
Recommended: the header** (§1 above).

The envelope (`{ items, total, limit, truncated }`) is the more conventional API design
and is genuinely better in one respect: it is impossible to ignore, whereas a header is
trivially ignored by a client that does not know to look. If this API had more than one
consumer, that would probably decide it.

It has one consumer, and the envelope's costs are all real: it changes the response shape
of `/inventory-transactions`, `/products/:id/transactions`, and (for consistency)
`/audit-events`; it breaks `Store.listAllTransactions`, `Store.listTransactionsForProduct`,
`Store.listTransactionsForSupplier`, and `Store.listAuditEvents`, all of which do
`rows.map(normalize…)` on a bare array; and it breaks every e2e assertion that indexes
into the response body. Most decisively, `total` is the only part of an envelope this
phase would actually use, and producing it needs the unbounded `COUNT(*)` over the same
filtered set that the cap exists to avoid. An envelope whose most valuable field is the
one you refuse to compute is a shape without a reason.

---

## 2. What's new (backend)

### No new dependency, no new module, no new route

One migration, one DTO extended, one DTO created, three service methods changed, one
interceptor added, one service method deleted from the frontend. No new endpoint appears
in `api.md`'s route tables — every change rides an existing route's existing shape and
role, as in Phase 7.

### Migration `1787830000000-AddInventoryTransactionsOccurredAtIndex.ts`

Sorting after `1787740000000-ConvertTimestampsToTimestamptz`.

```ts
// Phase 11 (docs/phase-11-plan.md §1 "The index Phase 9 added and Phase 2 never did").
// Both transaction log reads ORDER BY occurred_at DESC and both gain a LIMIT in this
// phase; ?days= filters on the same column. inventory_transactions has carried exactly
// one index since InitSchema — on product_id — so today that ordering is a full scan
// plus a sort, and a LIMIT on top of it reduces what crosses the wire without reducing
// any work Postgres does.
//
// The composite (occurred_at DESC, id DESC) is not a hedge: it is the exact ordering
// §1 requires. occurred_at comes from <input type="date">, so every transaction on one
// business day is byte-identical in that column and the sort is not total without the
// primary key appended. Indexing only occurred_at would leave Postgres sorting the ties.
//
// Additive, unlike Phase 10's converting migration: down() drops the index and loses
// nothing. CREATE INDEX, not CONCURRENTLY — TypeORM runs migrations inside a
// transaction, which CONCURRENTLY cannot join, and at this table's size the lock is
// milliseconds.
up:   CREATE INDEX "IDX_inventory_transactions_occurred_at_id"
        ON "inventory_transactions" ("occurred_at" DESC, "id" DESC)
down: DROP INDEX "public"."IDX_inventory_transactions_occurred_at_id"
```

The entity gains the matching declaration so `smart_inventory_test`
(`synchronize: true`) builds it too — a class-level `@Index(['occurredAt', 'id'])` on
`InventoryTransaction`, beside its existing `@Check`es and the `@Index()` on the
`product` relation (the decorator that produces `IDX_2520d97…` on `product_id`).
**This is the same three-registries problem Phase 9 §2 and Phase 10 §2 both had**: the
migration covers `smart_inventory` and `smart_inventory_e2e`, and only the entity
declaration covers `smart_inventory_test`. Getting one and not the other is green in CI
and wrong in production, or the reverse.

**The two declarations will not be byte-identical, and that is fine but must be
deliberate.** TypeORM's class-level `@Index([...])` takes column names and has no way to
express per-column `DESC`, so `smart_inventory_test` gets `(occurred_at ASC, id ASC)`
where the migration creates `(occurred_at DESC, id DESC)`. Postgres scans a b-tree
backwards at the same cost, so both satisfy `ORDER BY occurred_at DESC, id DESC` as an
index scan and no query behaves differently — but a reviewer diffing the two schemas will
find a difference, so the entity carries a one-line comment saying it is expected and
why, rather than leaving the next person to decide whether they have found a bug.

### `QueryTransactionsDto` — gains `limit`

```ts
// Phase 11 (docs/phase-11-plan.md §1). Deliberately identical to
// QueryAuditEventsDto's limit, down to the decorators: the floor and the ceiling are
// validation, not clamping, so limit=100000 is the documented 400 rather than a
// silent reinterpretation (Phase 9's reasoning, unchanged). Default lives in
// InventoryService, not here, for the same reason it lives in AuditService.
@IsOptional()
@Type(() => Number)
@IsInt()
@Min(1)
@Max(500)
limit?: number; // default 100, applied by InventoryService.listAll
```

`days` also gains the `@Min(1)` floor `QueryAuditEventsDto` has and this DTO does not —
today `?days=0` on `/inventory-transactions` silently produces an empty result (a cutoff
in the future) where `/audit-events` correctly returns `400`. Small, unrelated to the
headline, and included anyway because it is the same DTO, the same field name, the same
argument already written down one file over, and leaving two spellings of one rule in the
codebase is worse than the one line it costs.

### `QueryProductTransactionsDto` — new, one field

`GET /products/:id/transactions` currently takes no query object at all
(`InventoryController.listForProduct` has only `@Param`). It gains a two-line DTO
carrying `limit` alone, rather than reusing `QueryTransactionsDto` — whose `productId`,
`supplierId`, and `type` would be meaningless-or-contradictory on a route that already
names its product in the path, and would be silently accepted and ignored.

### `InventoryService` — three changes

| Method | Change |
|---|---|
| `listAll` | `.orderBy('tx.occurredAt','DESC').addOrderBy('tx.id','DESC')`; `.take((query.limit ?? DEFAULT_LIMIT) + 1)`; return the trimmed rows plus a truncation flag |
| `listForProduct` | same ordering and cap; move from `repository.find` to the query builder so `take` and `addOrderBy` read the same way as `listAll` |
| `countSince` | **new.** `SELECT COUNT(*)` with the `days` cutoff, no joins, no rows materialised — replaces the second full read in `DashboardService` |

The truncation flag has to reach the controller without changing the service's return
type into something every caller must destructure. The mechanism: both list methods
return `{ rows, truncated }` internally; the controller sets the header and returns
`rows`. Only two call sites exist, so this is a small change rather than a refactor —
and the alternative (a service that mutates a response object) would put HTTP knowledge
inside `InventoryService`, which today has none.

### `DashboardService.getSummary` — the actual win

```
before:  listAll({}).slice(0, 8)            → whole table, three joins, 8 rows kept
         listAll({ days: 7 }).length        → whole 7-day window materialised, 1 int kept

after:   listAll({ limit: 8 })              → 9 rows fetched
         countSince(7)                      → one COUNT(*), no rows
```

**No field of `GET /dashboard/summary` is renamed or restructured, but two are computed
more precisely than before** — and neither is accurately described as "byte-identical":

- **`recentActivity`** is equivalent to the old result *on tie-free data*. Where two
  transactions share an `occurred_at` at the 8-row boundary, the old
  `listAll({}).slice(0, 8)` returned whichever eight the executor happened to order
  first for `ORDER BY occurred_at DESC` — execution-plan-dependent, and the plan can
  change under a vacuum, an `ANALYZE`, or the very index this phase adds. The new
  `ORDER BY occurred_at DESC, id DESC LIMIT 8` is deterministic: newest-inserted first
  among a tie. So the tie-break does not *preserve* the old behaviour, it *replaces a
  latent nondeterminism with a defined order*. This is the whole reason §1's first
  decision exists.
- **`transactionsLast7Days`** counts the same predicate, but the `?days=` cutoff is now
  calendar-day aligned (see the "`?days=N` is calendar-day aligned" note below): a
  transaction dated exactly seven days ago is counted no matter what hour the dashboard
  is opened, which the old time-carrying cutoff did not guarantee. On any given
  calendar day the integer is stable; across the old/new boundary it can differ by the
  transactions dated on the boundary date itself.

The ordering change is not cosmetic and must land with, or before, the cap.

### `?days=N` is N calendar dates ending with today (Phase 11 review, corrected twice)

**The contract:** `days=N` covers exactly `N` calendar dates, the last of which is
today. `days=1` is today alone; `days=7` is today plus the previous six. A row dated six
days ago is in, seven days ago is out, and the answer does not move with the hour.

Getting there took two corrections, and both are worth keeping on the record because
each was a different mistake.

**Round 1 — the original defect, stated more narrowly than the first fix claimed.**
`InventoryService`'s cutoff was `new Date()` with `setDate(getDate() - N)` and nothing
else, so it kept the current time of day. `occurred_at` is a user-picked date with no
time (`insertTransaction` stores `new Date('YYYY-MM-DD')`, i.e. **UTC** midnight), so
that cutoff usually sat mid-day inside the boundary date and excluded it. But *not
always*: the stored value is UTC midnight of a date the user picked in **their own**
zone, so whenever the local date runs ahead of the UTC date — the small hours of a
positive-offset zone, which is exactly this project's UTC+7 — the boundary row fell back
inside the window. So the window was 7 *or* 8 dates depending on the hour. Hour-dependent
during a daily window, not at every hour, and not a plain off-by-one; the first fix's
comment overstated it as the latter.

**Round 2 — the first fix removed the hour-dependence and widened the window.**
`setHours(0, 0, 0, 0)` with `setDate(getDate() - N)` snaps to the start of the date `N`
days back, which makes the window `N + 1` dates: `days=7` returned eight, verified
against the running API. Deterministic, and wrong by a day. The correction is
`- (days - 1)`.

**Why this lives in one module and still needs two functions.**
`common/days-cutoff.ts` owns the rule so the two screens cannot drift, but it exports
`daysCutoffForDateColumn` and `daysCutoffForInstantColumn`, because a single formula is
provably wrong for one of the two columns. Swept over all 24 hours at `days=7`, counting
distinct dates returned:

| cutoff | `occurred_at` (date-only) | `created_at` (instant) |
|---|---|---|
| local start-of-day | 7 at offset ≥ 0, **6** at offset < 0 | 7 everywhere |
| UTC-anchored to the local date | 7 everywhere | 7 at offset ≥ 0, **8** at offset < 0 |

A date-only column has to be compared against the same construction that wrote it (UTC
midnight of a local calendar date); an instant column has to be compared against a real
local instant. On UTC+7 the two agree exactly — which is why choosing either by accident
would have looked correct here forever, the same shape of unstated precondition Phase 10
spent a phase deleting. Naming both is the cheap way to not repeat it.

No new BR — a filter's window is a property of the read, not a rule about the business.

`needsAttention` and the four counts are untouched: they read from `products`, a
catalogue Fork A leaves unbounded, and BR-062 already defines their scope.

### `TruncationHeaderInterceptor` — or the absence of one

Considered and **declined**. Setting one header in two controllers is two lines; an
interceptor to do it would have to infer from a response body whether truncation
happened, which is exactly the information the body no longer carries. The controllers
set it directly with `@Res({ passthrough: true })`. Recorded here because "surely this is
cross-cutting" is the reviewer's first instinct, and it is the same instinct Phase 9 §1
talked itself out of for `AuditService.record` (an explicit service call, not a global
interceptor) — `cross-cutting-concerns.md` already carries that argument and this is a
second instance of it.

### `run-seed.ts`, `configuration.ts`, `.env.example` — no change

§1. Consistent with Phases 7 through 10, each of which left the seed alone for its own
reason; here it is that seeding writes rows and this phase only reads them.

---

## 3. Frontend changes

Three, and one of them is a deletion.

**1. `Store.recentActivity` is deleted, not bounded.** It reads:

```js
async recentActivity(limit){
  const rows = await this._request('GET', '/inventory-transactions');
  return rows.slice(0, limit).map(normalizeTx);
}
```

— the same fetch-everything-and-slice defect as `DashboardService.getSummary`, one layer
up and across the wire. It is also **dead**: the dashboard view calls
`Store.getDashboardSummary()` and renders `summary.recentActivity`; nothing in
`index.html` calls this method. A dead method that would be wrong if it were live is
better deleted than fixed, and finding it is the more useful outcome of this phase's
audit than fixing it would have been.

**2. `Store.listAllTransactions` and `listTransactionsForProduct` pass `limit` and read
the header.** `_request` currently returns parsed JSON and discards the `Response`, so it
gains a way to expose one header to the two callers that need it — the smallest change
that works, not a general response-metadata layer.

**3. The History screen says when it truncated.** One line above the table — *"Showing
the most recent 100 movements. Narrow the range or filter by product to see more."* —
rendered only when the header is present. Without it, a user whose shop has been open
two years sees a history screen that silently stops in the middle of last month, which
is the wrong-data-that-looks-right failure §1 refuses to ship.

The Product Detail history panel gets the same line on the same condition, but with a
different hint: it has no range or type filter, so telling its reader to "narrow the
range" would point at a control that isn't there. Its hint states the fact only —
*"This product has more history than one page shows."* The Supplier Detail "received
from" panel is in the same position and reads the same way. Giving either screen a way
to actually reach past the first 100 rows is deferred — see §7.

**Explicitly not in this phase's frontend:** a page-size control, a "load more" button,
infinite scroll, or a page-number strip. All four are the paging *design* Fork A defers,
and adding one to the History screen alone would make it the only paged screen in an app
where the Product List is not — an inconsistency worse than the one this phase fixes.

---

## 4. Documentation updates

1. **`api.md`** — title bumped to Phase 11. The two log routes gain `limit` in their
   query column and a note that the response is capped, newest-first, with no offset
   pagination — the same sentence `/audit-events` already carries, now true of three
   routes instead of one. A new short paragraph beside the `429` and `403` conventions:
   **`X-Result-Truncated: true` means more rows matched than were returned**, present on
   the three capped routes and no others. One sentence recording that the four catalogue
   reads are deliberately uncapped, with a pointer to §7 — because a reader who sees
   three capped routes will reasonably assume the other four were an oversight.

2. **`requirements.md`** — a fourth "no new FR" note beside Phase 7's, Phase 8's, and
   Phase 10's, and it carries the one thing this phase must not leave unstated: **FR-030
   and FR-031's word "all" describes the screen's subject, not a single response's
   payload.** A history screen that pages still lets a user "view the chronological list
   of all transactions"; a request that returns 100 of them does not stop it being true.
   Recorded as an interpretation with its reasoning, in the same spirit as Phase 9's
   FR-065 note recording why *that* phase did add one.

3. **`business-rules.md`** — **no new BR**, recorded in one line with its reason (§1), the
   second such line after Phase 10's. BR-050, BR-051, and BR-062 gain nothing; a cap on a
   transport does not change what is true of a row.

4. **`architecture-observations.md`** — a new entry under the cross-cutting section, and
   it belongs to that file's actual purpose rather than being a summary of this plan.
   Content: the census table from "Why this phase, why now"; the finding that Phase 9's
   stated reason for capping (`an attacker grows this table`) was narrower than its real
   one (`the result size is a function of elapsed time`), and that acting on the narrow
   form is what left five other reads uncapped for two phases; and the four catalogue
   reads recorded as a **named, unenforced precondition** — "this business will not
   accumulate more products/suppliers/users than one response can carry" — in the same
   register as the in-memory throttle store and the best-effort audit write already
   recorded there. That file now holds three preconditions of one shape, which is itself
   worth a sentence: it is the pattern, not three coincidences.

5. **`product.md` §11** — a Phase 11 cross-reference in the style of Phase 7's and
   Phase 10's, not Phase 9's: no user goal in §4, no use case in §5, no scope change in
   §7. Q-4, Q-6, and Q-7 remain exactly as open as before.

6. **`domain-model.md`** — **no change**, and the absence is worth one line in this list
   rather than silence, because Phases 7, 9, and 10 each edited §8 and a reader will look.
   Nothing here is about an entity, a relationship, an invariant, or a column's meaning.

7. **`README.md`** — Current phase updated, plus one operational note in the register of
   the Riley, lockout, and empty-audit-log ones: **the history screen showing "the most
   recent 100" is the feature, not a broken query**, and `?days=` or a product filter is
   how to see past it. Plus the `migration:run`-against-both-databases reminder Phase 10
   established, since this phase also ships a migration.

8. **`docs/learning-notes/database-access.md`** — extended, not a new note, following
   Phase 10's precedent for the same reason (this is TypeORM and `pg` mechanics, and that
   note already owns them). Content: `take` vs `limit` in the TypeORM query builder and
   why `take` issues a two-query DISTINCT form once a join is present; `addOrderBy` and
   why **a `LIMIT` over a non-total `ORDER BY` returns an arbitrary subset**, with this
   table's date-only `occurred_at` as the worked example; and the `limit + 1` probe as the
   standard way to know there is more without paying for `COUNT(*)`. The generalizable
   lesson, in that file's usual currency: **sorting and limiting are one operation, not
   two — a sort that was good enough to display becomes a correctness bug the moment
   something cuts it off.**

---

## 5. Testing plan

The shape here is the inverse of Phase 10's, and worth saying before the list. Phase 10's
problem was that its existing suite *could not tell before from after*. This phase's
problem is the opposite: the existing suite will tell the difference loudly, in places
that are not about the change, because several specs assert on complete result sets that
are about to become capped ones. Most of the work is separating *that* noise from real
regressions.

- **Integration — `inventory.service.integration.spec.ts`** (existing file, extended;
  real Postgres, which this suite already uses for the concurrent stock-out test):

  - **The tie-break is the headline test, and it must fail on a tree without the
    tie-break.** Insert 30 transactions across three products all carrying the *same*
    `occurred_at` (the realistic case — one business day), request `limit: 10` repeatedly,
    and assert the same ten ids come back every time. Then assert those ten are the ten
    highest ids. Verified the way Phase 10 verified its headline test: by removing
    `addOrderBy('tx.id','DESC')` and confirming the assertion actually goes red — because
    a test that passes on both trees proves nothing, and Phase 10 §5 shipped exactly that
    test twice before catching it.

    **Expect this to need effort to make fail reliably.** With a small table and a fresh
    index Postgres may return tied rows in physical order and look deterministic. If it
    does, the test is strengthened — more rows, an `ANALYZE`, or asserting against the
    explicit expected id set rather than against a second call's output — rather than
    accepted as green. A tie-break test that cannot be made to fail without the tie-break
    is not testing the tie-break.
  - **The cap and its off-by-one.** With 150 rows: no `limit` returns 100;
    `limit: 500` returns 150; `limit: 150` returns exactly 150 **and no truncation flag**
    (the `limit + 1` probe's boundary — the case where the extra row is asked for and
    genuinely does not exist); `limit: 149` returns 149 **with** the flag.
  - **`countSince` matches the old computation.** Assert `countSince(7)` equals
    `listAll({ days: 7, limit: 500 }).rows.length` on a fixture small enough for both to
    be exact. It pins that the dashboard's integer did not change meaning when its
    mechanism did.

- **E2E — `app.e2e-spec.ts` and any spec touching the two log routes:**
  - `?limit=0`, `?limit=501`, `?limit=abc` → `400` in the documented validation shape.
    `?days=0` → `400`, which it is not today.
  - `X-Result-Truncated` present when it should be and **absent — not `false` — when it
    should not.** A header that is always present with a boolean string is a different
    contract from one whose presence is the signal, and `api.md` documents the latter.
  - The existing `/audit-events` specs get one assertion for the same header, since
    Phase 9's route gains it (§1).

- **Existing suites — where breakage is expected rather than a regression.** Any spec
  that seeds more than 100 transactions and asserts on the full array will now see 100.
  The census is small (the e2e fixtures are deliberately tiny), but the rule for handling
  each one is what matters and it is not "adjust the number until green": a spec asserting
  *completeness* passes `limit: 500` explicitly and says why in a comment; a spec that
  merely counted rows incidentally is left to the new default. Conflating the two is how
  a real regression gets normalised into an expected diff.

- **Unit — `dashboard.service.spec.ts`.** The existing mock of `InventoryService` gains
  `countSince` and its `listAll` mock gains the new return shape. Worth one assertion of
  its own: **`listAll` is called with a `limit`**, not with `{}`. That is the only place
  the phase's actual defect — a dashboard that reads the whole table — can be pinned as a
  regression guard, and it is cheap.

- **No new unit test for the DTOs.** `@Min`/`@Max` on a DTO is `class-validator`'s
  behavior, and the e2e `400` cases above already prove the wiring end to end. Same call
  Phase 10 made about testing decorator metadata.

---

## 6. Rollout order

1. **The migration and the entity `@Index`, alone, against `smart_inventory`.** No service
   or DTO changes yet. Verify the index exists in `pg_indexes` and that
   `EXPLAIN SELECT … ORDER BY occurred_at DESC, id DESC LIMIT 100` uses it rather than a
   seq scan + sort. Individually shippable: an index changes no result, only a plan, so
   nothing before this step has to be reverted if a later one goes wrong — the same
   de-risking arrangement Phases 8, 9, and 10 each put first.
2. **`npm run migration:run` against `smart_inventory_e2e`.** Its own step, for the
   reason Phase 10 §2 named: it is the database that gets forgotten, and forgetting it
   looks like success rather than failure.
3. **The ordering change alone — `addOrderBy('tx.id','DESC')` on both reads, no cap
   yet.** Deliberately separated from step 4. It changes which of several valid orders is
   returned and nothing else; landing it on its own means that if the full suite moves
   here, the cause is unambiguous. It is also the step that must not be skipped if the
   phase is cut short (see below).
4. **The DTOs, the service caps, and the controllers' header.** The behavior change.
5. **`DashboardService`** — `listAll({ limit: 8 })` and `countSince(7)`. After step 4, so
   that a dashboard regression points at the composition rather than at the cap.
6. **The frontend** (§3) — delete `Store.recentActivity`, thread `limit` and the header
   through the two list methods, add the truncation line to both history views.
7. **The new and adjusted tests** (§5) — the tie-break spec last among the code steps,
   for Phase 10's reason: it is the only test that can fail *for the right reason*, and
   running it against an otherwise-green tree means a red result points at the phase's
   subject rather than at its plumbing.
8. **Documentation** (§4). As in every phase in this series, these outlast the code and
   are not optional in any cut.

If this phase is cut short, the coherent stopping point is **after step 3**: the ordering
is total, the index is there, and every response is exactly what it was before — a strictly
better tree with no behavior change. Stopping between steps 4 and 6 is the one genuinely
bad place to stop, because the backend truncates and the frontend does not say so, which
is the silent-cap defect §1 exists to refuse.

---

## 7. Explicitly out of scope for Phase 11 (Future)

- **Bounding the four catalogue reads** (`/products`, `/suppliers`, `/categories`,
  `/users`) — Fork A. Listed first because it is what a reviewer will check for, and its
  absence is a decision rather than an oversight. **Its trigger is concrete**, in the
  manner of Phase 9 §7's retention policy: when the Product List screen is slow enough for
  someone to mention it, or when a real deployment passes a few hundred products, the
  answer is a paging design for that screen — a total, a next page, and moving the low/out
  filter into SQL — not a ceiling bolted onto the existing route.
- **A way past the first 100 rows on the two scoped-history screens — Product Detail and
  Supplier Detail.** Both now consume the capped transaction endpoint
  (`GET /products/:id/transactions` and `GET /inventory-transactions?supplierId=`
  respectively), so each shows at most the most recent 100 rows *for that product / that
  supplier*, with a truncation notice and no control that reaches older rows. The global
  Inventory History and the Audit Log are different: their range and type/account filters
  genuinely let a user narrow down to rows the first 100 didn't include, so their notice
  points at those filters. Product Detail and Supplier Detail have no such controls, and
  adding a filter row or a paging strip to a per-entity panel is a screen-design decision,
  not a transport one — deliberately not made here. When it is made, the two identified
  shapes are: (a) give the relevant screen/route real paging or range/filter controls, or
  (b) an explicit "show all" affordance that re-requests with a deliberately larger
  `limit`. Neither is built now; the notice stating the fact is the whole of Phase 11's
  answer.
- **Offset or cursor pagination anywhere** — `/audit-events` declined it in Phase 9, and
  three capped routes do not make a paging feature. "The most recent N, narrow with
  filters" is the whole interaction model, and adding `?offset=` to a table where new
  rows arrive at the top would ship the classic skipped-row bug for free.
- **A `total` or `X-Total-Count`** — Fork B. Computing one means the unbounded
  `COUNT(*)` over the filtered set that the cap exists to avoid, and no screen displays a
  total today.
- **Streaming, cursors, or server-side export of the full history** — the shape of answer
  for "I actually do need every row," and a genuinely separate feature with a format
  decision and a download route. It is the same feature Phase 9 §7 parked as audit-log
  export, now wanted for a second table; if either is ever built they should be designed
  together.
- **Making the dashboard's `recentActivity` count or its 8-row window configurable** —
  §2 changes how those are computed and not what they are. The 8 and the 5 in
  `getSummary` are UI constants that predate this phase and are not its business.
- **Caching, materialising current stock, or a read model** — `architecture-observations.md`
  has said since Phase 2 that current stock is derived and may be materialised *later, for
  a measured reason*; a result cap is not that reason and does not become one.
- **Indexing anything else** — `tx.type`, `tx.supplier_id`, and the catalogue tables'
  `name` orderings are all unindexed too. None of them is on the path of a read this
  phase caps, and adding indexes because they might help is the speculation this project's
  own "what evidence to look for" section argues against.
- **A retention or pruning policy for `audit_events`** (Phase 9 §7) — still parked, still
  with its trigger unfired. Named here because this phase makes it *less* urgent, not
  more: a capped read is most of what a large audit table was going to hurt.
- **A shared throttle store** (Phase 8 §7) — still parked, still recorded in
  `architecture-observations.md`, still not this phase's problem.
- **Tamper-evidence, alerting, or a dashboard tile derived from the audit log**
  (Phase 9 §7) — all unchanged, none of them adjacent to this.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.
- **Q-6, adjustment approval workflow** — still open, still untouched, still not resolved
  by anything here, exactly as Phases 5 through 10 each recorded. Seven consecutive
  phases have now deferred it by name, which by Phase 10 §"Why this phase"'s own logic is
  starting to be an argument in itself.

---

## 8. Definition of done

- [ ] `GET /inventory-transactions` and `GET /products/:id/transactions` accept `limit`
      with the same floor, ceiling, and default as `/audit-events` — `@Min(1)`,
      `@Max(500)`, default 100 in the service — and an out-of-range value is the
      documented `400`, never silently clamped.
- [ ] Both reads order by `occurred_at DESC, id DESC`, and the tie-break is **proven** by
      a test that goes red when `addOrderBy` is removed — not by inspection, and not by a
      test that passes on both trees (Phase 10 §5's lesson, applied before rather than
      after).
- [ ] `IDX_inventory_transactions_occurred_at_id` exists in **both** `smart_inventory` and
      `smart_inventory_e2e`, is declared on the entity so `smart_inventory_test` builds it
      too, and `EXPLAIN` shows the capped read using it instead of a seq scan plus sort.
- [ ] `X-Result-Truncated: true` is set on `/inventory-transactions`,
      `/products/:id/transactions`, **and `/audit-events`** when more rows matched than
      were returned, and is **absent** — not `false` — otherwise. `/audit-events` has been
      silently truncating since Phase 9 and stops.
- [ ] The truncation signal costs no extra query: it comes from asking for `limit + 1` and
      checking whether the extra row arrived. The `limit == total` boundary returns the
      full set with no flag, asserted.
- [ ] `DashboardService.getSummary` no longer materialises the transaction table. It calls
      `listAll({ limit: 8 })` and `countSince(7)`. `recentActivity` is unchanged on
      tie-free data and now *deterministic* (not merely "stable in practice") where rows
      tie on `occurred_at`; `transactionsLast7Days` counts the same predicate over a
      calendar-day-aligned window. Neither is described as universally "byte-identical".
- [ ] `?days=N` on `/inventory-transactions`, in `countSince`, and on `/audit-events`
      returns exactly `N` calendar dates ending with today. Integration tests prove
      `days=7` returns today plus the previous six — a row dated six days ago in, seven
      days ago out — that `days=1` is today alone, and that the answer is the same at
      four different hours of the day; a unit test pins `/audit-events`' cutoff to the
      same contract. All four go red against the `- days` version. The rule lives in
      `common/days-cutoff.ts` as two functions, one per column kind, with the sweep
      showing why one formula cannot serve both.
- [ ] `Store.recentActivity` is **deleted** from `frontend/index.html` — dead, and wrong
      if it had been live.
- [ ] Both history views display a truncation line when and only when the header is
      present, so no screen in the app silently stops in the middle of the record.
- [ ] `?days=0` returns `400` on `/inventory-transactions`, matching `/audit-events`,
      rather than silently returning an empty result.
- [ ] Every existing spec that changed was classified before it was edited: asserting
      completeness (→ explicit `limit: 500` with a comment) or counting incidentally
      (→ left to the default). No spec's expected number was adjusted until green.
- [ ] The two scope forks were decided and recorded either way: two log reads vs. all six
      lists (§1 fork A), and a response header vs. an envelope (§1 fork B).
- [ ] `api.md` (Phase 11) documents `limit` and the header on three routes **and** records
      that the four catalogue reads are deliberately uncapped; `requirements.md` carries a
      fourth no-FR note **with FR-030/FR-031's "all" explicitly interpreted**;
      `business-rules.md` gains a no-new-BR line; `architecture-observations.md` records
      the census, Phase 9's narrower-than-necessary reason, and the catalogue reads as a
      third named precondition; `product.md` §11, `README.md`, and `database-access.md`
      all reflect the phase; `domain-model.md` is deliberately unchanged — and Q-4, Q-6,
      and Q-7 are still recorded as open.
- [ ] Full backend suite green: unit, integration (including the new cases), and all six
      e2e specs.
