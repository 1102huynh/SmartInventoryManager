# Architecture Observations — End of Phase 2

Status: Phase 2 — NestJS Backend
Last updated: 2026-08-19

This is **not** a Go/Kafka design. Per this phase's brief, no such design should
happen yet. This is a record of what the current NestJS implementation actually
revealed, to inform that decision later with evidence instead of speculation.

## What currently belongs naturally in NestJS

Everything, right now. Categories, Suppliers, Products, Users, and Dashboard are all
thin, I/O-bound layers over PostgreSQL — CRUD plus a bit of composition (Dashboard).
None of them do meaningful computation, none are a throughput bottleneck at this
project's scale (a single small business, dozens of products, tens of transactions a
day), and all of them benefit from staying in one process: one shared TypeScript type
system with the frontend, one deployable unit, one place to reason about a request.
The full documented MVP runs comfortably as a single NestJS app + Postgres — see
`docs/backend-use-cases.md`. There is no measured problem this phase's implementation
has that a language or process split would fix.

## Areas that may eventually benefit from Go

**`InventoryService`** (`backend/src/inventory/inventory.service.ts`) is the one
piece of this codebase doing something a thin CRUD layer doesn't: the pessimistic
row-locking in `recordStockIn`/`recordStockOut`/`recordAdjustment` (see
`docs/learning-notes/database-transactions.md`) is real concurrency-sensitive domain
logic, not just data access. If this project ever needs to sustain a much higher rate
of concurrent stock mutations than a small business generates today — many
concurrent locations, high-frequency POS integration, batch imports — Go's
goroutine-based concurrency model may handle that load with less resource overhead
than Node's single-threaded event loop plus a connection-pool-bound ORM. That's a
real, specific difference between the two runtimes, not a generic "Go is faster"
claim.

Notably, the module boundary this phase already drew — `ProductsModule` and
`DashboardModule` depend on `InventoryModule` through `InventoryService` alone, and
`InventoryModule` depends on nothing else — is exactly the seam a future extraction
would need. If `InventoryService`'s logic ever moved to a separate Go service, the
NestJS side would swap an injected `InventoryService` for an HTTP/gRPC client with
the same method signatures; `ProductsService` and `DashboardService` wouldn't need to
change. That this boundary was already clean is a useful data point, not a reason to
act on it yet.

## Areas that may eventually benefit from Kafka

Nothing in the current system reacts to an inventory change asynchronously — a
stock-in/out/adjustment is a single synchronous request/response, and the Dashboard's
"recent activity" and "needs attention" are computed by querying current state at
request time (`DashboardService.getSummary`), not by consuming a stream of past
events. This works cleanly for everything in the documented MVP.

Kafka would earn its place the moment there's a **second real consumer** of inventory
change events that shouldn't be coupled to the write request's response cycle —
concrete, not hypothetical, examples the product docs already gesture toward:

- A notification channel (email/SMS) firing when stock crosses a low-stock threshold.
- A future reporting/analytics pipeline that shouldn't slow down or fail the
  stock-out request itself.
- The Future-scope "integration with third-party systems" line in `product.md` §8 —
  if that's ever revisited, syncing stock changes outward is the shape of problem
  event streaming solves well.

None of these exist yet. Introducing Kafka now, with one producer and no real
consumer, would add real operational cost (a broker to run, a schema to maintain, a
new failure mode) for zero present benefit — exactly the premature complexity this
phase's brief said to avoid.

**[Added 2026-08-25, Phase 9]** The audit log is the closest this system has come to
the criterion above — and it still does not meet it. Phase 9 (`docs/phase-9-plan.md`)
built a second consumer of *events* (`AuditService.record`, called from `AuthService`,
`UsersService`, `ProductsService`, `SuppliersService`, `CategoriesService`), but §1 of
that plan deliberately excludes inventory events from it (BR-083): the audit log
consumes authentication and administrative events, for which there was previously no
producer or consumer at all — not a second consumer of the *inventory* events this
section is actually about. So the bar named above remains unmet, and this phase is
**evidence for** that conclusion rather than against it: a genuine new event-consuming
concern arrived, and the right answer was still an in-process service call, not a
broker. Exactly the kind of concrete data point this file exists to accumulate
instead of speculation.

## What evidence to look for before extracting anything

- **For Go**: a measured throughput or latency problem in `InventoryService`
  specifically — not a hunch, an actual number (requests/sec, p99 latency under
  realistic concurrent load) that NestJS+Postgres can't sustain, or a genuine
  organizational reason (a team that owns "inventory correctness" wanting its own
  language/deploy cadence, independent of the BFF).
- **For Kafka**: a second consumer of inventory events that actually exists or is
  imminently planned — not "we might want this later." One producer with zero
  consumers is a queue nobody's reading, not an architecture.
- **For either**: confirmation the current single-process design has actually become
  the constraint, rather than assuming it will. This phase's implementation handles
  the documented MVP, including its one genuinely tricky concurrency case (see the
  concurrent stock-out test in `inventory.service.integration.spec.ts`), without
  needing either.

## Cross-cutting: audit-timestamp convention (Phase 7)

As of Phase 7 (`docs/phase-7-plan.md`), every table follows one uniform rule for
`created_at`/`updated_at`, defined in `domain-model.md` §8: every row gets
`created_at`; a row that can change also gets `updated_at`; `inventory_transactions`
is the one deliberate exception (create-only, because BR-051 makes those rows
immutable). This closed the last gap — `users` and `categories` had neither column
before this phase; `products`, `suppliers`, and `inventory_transactions.created_at`
had theirs since `InitSchema`.

**A known, deliberately deferred question** (as of Phase 7): all of these audit
columns were plain `TIMESTAMP` (no timezone), matching the four that existed before
Phase 7 rather than introducing a second convention mid-schema. There's a real
argument that server timestamps should be `timestamptz` throughout — the plain
`TIMESTAMP` columns were implicitly server-local/UTC by convention, not by an
enforced type — but that's a schema-wide migration touching every existing audit
column at once, not something to decide as a side effect of adding two tables' worth
of columns. Parked here as a known latent question, not resolved.

**[Updated 2026-08-25, Phase 9]** Deferred a third time (Phase 8 §1 declined to
reopen it; `docs/phase-9-plan.md` §1 defers it again), and each new table made the
eventual migration one table wider. The exact list, so the next person deciding has
one instead of an impression — every plain `TIMESTAMP` column in the schema as of
Phase 9, ten pre-existing plus one new:

- `products.created_at`/`updated_at`, `suppliers.created_at`/`updated_at` (`InitSchema`)
- `inventory_transactions.created_at` (`InitSchema`; contrast `occurred_at`, `timestamptz`, above)
- `users.created_at`/`updated_at`, `categories.created_at`/`updated_at` (Phase 7)
- `users.locked_until` (Phase 8 — operational state, not an audit column, but the
  same plain-`TIMESTAMP` convention; see that migration's own comment)
- `audit_events.created_at` **[new, Phase 9]**

Eleven columns across six tables, up from ten across five before Phase 9. It only
grew, never shrunk, every phase since Phase 7 first parked the question — until now.

**[Resolved 2026-08-25, Phase 10]** All eleven columns above are `timestamptz` as of
`docs/phase-10-plan.md`, converted in one migration
(`1787740000000-ConvertTimestampsToTimestamptz.ts`). This is the first entry this
file has ever *closed* rather than accumulated — worth noting because this file's
stated purpose is to inform later decisions with evidence, and an entry that only
ever grows is not evidence of anything.

The actual argument, once it was measured rather than assumed: **a plain `TIMESTAMP`
column stores digits with no zone marker, and the zone those digits are written in is
not the zone they are read back in.**

- **Write — but "TypeORM's write" turned out not to be one mechanism.** `DEFAULT now()`
  produces digits in **Postgres's session zone**, obviously. So does
  `@CreateDateColumn`/`@UpdateDateColumn` — not because TypeORM hands `pg` a computed
  `Date` for them, but because it doesn't: when the entity carries no value for that
  field (the only way any service in this codebase uses them), TypeORM emits the
  literal SQL `DEFAULT` on insert and appends `CURRENT_TIMESTAMP` on update
  (`docs/learning-notes/database-access.md`'s pre-existing note on exactly this, since
  Phase 8) — the same Postgres-side expression as `DEFAULT now()`, evaluated in the same
  session zone. The one column in this schema that *is* a genuine TypeORM-computed
  parameter — `user.lockedUntil = new Date(...)` in
  `UsersService.registerFailedLogin`, which has no database default to defer to — behaves
  differently: `pg` serializes that `Date` with an offset the naive column then discards,
  keeping **Node's own zone**, not Postgres's session zone. Confirmed for both cases by
  pinning three different session zones and watching only the deferred columns track
  them; `locked_until`'s digits tracked Node's real zone instead, unmoved by any of the
  three.
- **Read.** `pg`'s `postgres-date` gets bare digits with no offset attached and builds
  a `Date` by treating them as local time in **the reading process's zone** — Node's,
  for every naive column regardless of which write path produced it.

So `created_at`/`updated_at` — every one of them, across all six tables — never
disagree with `DEFAULT now()`, because they *are* `DEFAULT now()`/`CURRENT_TIMESTAMP`
under the hood; the writer and the reader disagree instead. On this project both
processes run on one developer's machine (`tools/README.md`), the two zones coincide,
every column round-tripped correctly, and nothing ever surfaced the problem — **the
precondition that made the old schema correct was never enforced, tested, or even named
until this phase named it.** The ordinary way it stops being true is not exotic:
Postgres in a container (UTC by default) with Node on the host, or the reverse. In that
arrangement every one of these naive timestamps reads back shifted by the offset,
uniformly — the same digits either way, with nothing to distinguish a shifted row from
an honest one.

`users.locked_until` does not share this exposure, and settling that took a third pass
(see below): its value is a genuine application-computed parameter with no database
default to defer to, so its write zone is Node's, same as its read zone. It is exposed
to a narrower risk instead — Node's own zone changing between the write and a later
read (a restart onto a differently-zoned host, a DST transition) — not to Postgres's
session zone at all.

**This is not the argument the phase was planned around, and the corrections are
themselves the evidence this file exists to collect.** `docs/phase-10-plan.md` §1
originally claimed the two writers disagreed with each other, each stamping its own
process's wall-clock. Building the test meant to demonstrate that disproved it, and a
second draft overcorrected into treating "TypeORM's write" as one mechanism uniformly
cast through Postgres's session zone — which would have meant `locked_until` shared the
audit columns' exposure too. Logging the actual generated SQL settled which columns
defer to the database (`DEFAULT`/`CURRENT_TIMESTAMP`, session-zone-governed) and which
send a real parameter (Node-zone-governed), and reverting `locked_until` specifically
and re-running the suite confirmed it empirically rather than by re-reading the driver
source a third time. The general lesson, in this file's usual currency: **an argument
nobody has run an experiment against is a hypothesis, and a generalization drawn from
one experiment is still a hypothesis about everything the experiment didn't cover.**
`docs/phase-10-plan.md` §5 records all three rounds and how each was tested.

The list above is kept, not deleted — it's the record of what got converted, the same
role it played while the question was still open.

**The migration pins the assumed source zone as an explicit literal**
(`SOURCE_ZONE = 'Asia/Ho_Chi_Minh'` in the migration file) rather than reading it from
`current_setting('TimeZone')`, which is what a bare `ALTER COLUMN ... TYPE timestamptz`
with no `USING` clause does implicitly. The implicit form is correct by construction
on the machine this migration was written for, but its failure mode is silent — it
is the *same* failure mode (a value whose meaning depends on unrecorded ambient
machine state) that this phase exists to remove. The literal's failure mode is loud:
a reviewer reads a zone name in the migration and either agrees or does not. See
`docs/phase-10-plan.md` §1 fork A for the full argument.

**It is two literals, not one**, once the write-zone mechanism above is precise about
which zone wrote which column: `SOURCE_ZONE` for the ten audit columns
(Postgres's session zone), `SOURCE_ZONE_NODE` for `locked_until` (Node's). They're
equal on this project for the same reason `SOURCE_ZONE` alone would otherwise have
looked sufficient — one machine runs both processes — but the migration keeps them as
separate constants specifically so that a deployment where the two processes' zones
genuinely differ has somewhere correct to put the second fact, rather than a single
name silently standing in for both.

## Cross-cutting: two rate-limiting mechanisms, two storage models (Phase 8)

Phase 8 (`docs/phase-8-plan.md`) adds two related but distinct controls, and they
deliberately don't share storage:

- **The request throttle** (`@nestjs/throttler`, `ThrottlerModule`) counts requests
  per client address per route, in the throttler's default **in-memory** store — a
  plain `Map`, alive only for the life of one Node process.
- **Account lockout** (`failed_login_attempts`/`locked_until` on `users`) counts
  consecutive failures per account, in **Postgres** — the same durable store as
  everything else in this app.

Single-process today (see "What currently belongs naturally in NestJS," above), so
both are correct as implemented: nothing is lost on a normal request cycle. The
specific thing to watch for: **the moment this app runs as more than one instance,
the lock keeps working unchanged (Postgres is shared), but the throttle silently
becomes per-instance** — an N-instance deployment would permit N× the configured
rate, with no error, no warning, just a quietly weaker limit. This is a genuinely
different failure mode from the usual "add a load balancer and things just work"
story most of this app's design gives, precisely because the throttle's storage
choice was made for single-process correctness, not multi-instance correctness.

**What to look for before scaling out**, in the same spirit as this file's "what
evidence to look for before extracting anything" section above: if this app is ever
deployed with more than one running instance in front of the same clients, the
throttle needs a shared store (`@nestjs/throttler` supports pluggable storage, e.g.
Redis-backed) before the configured limits mean what they say. Not solved here,
deliberately — see `docs/phase-8-plan.md` §7 "A shared throttle store."

**[Added 2026-08-25, Phase 9]** `AuditService.record`'s best-effort write (BR-082 —
a repository failure is caught, logged, and swallowed, never rethrown) is a second
instance of the same shape as the throttle's in-memory store above: **correct at
this project's current scale, on a named precondition that a future deployment could
silently invalidate.** The throttle's precondition is single-process; the audit
log's is "a write failure here is rare and tolerable, because the log is a record,
not a proof" (`docs/phase-9-plan.md` §1). Neither precondition is checked at
runtime, and neither fails loudly if it stops holding — the throttle quietly permits
more than configured, and a run of `record()` failures quietly thins the log,
with no error surfaced anywhere a person would see it. Watch for the same kind of
evidence in both cases: a real, not hypothetical, sign the precondition has moved
(e.g. audit writes actually failing in production) before treating either as
something needing an alarm, a retry queue, or a durability guarantee it does not
today have.

## Cross-cutting: unbounded reads, and Phase 9's narrower-than-necessary reason (Phase 11)

Phase 11 (`docs/phase-11-plan.md`) capped the two transaction log reads. The census it
was scoped from, taken from the repository rather than from memory:

| Route | Service method | Bound before Phase 11 | Ordered by | What makes it grow |
|---|---|---|---|---|
| `GET /audit-events` | `AuditService.findAll` | `limit`, default 100, `@Max(500)` (Phase 9) | `event.id DESC` | every login attempt, anonymous included |
| `GET /inventory-transactions` | `InventoryService.listAll` | **none** | `tx.occurredAt DESC` | **every stock movement, forever** |
| `GET /products/:id/transactions` | `InventoryService.listForProduct` | **none** | `occurredAt DESC` | **every stock movement on that product, forever** |
| `GET /products` | `ProductsService.findAll` | none | `product.name ASC` | an Owner deciding to add a product |
| `GET /suppliers` | `SuppliersService.findAll` | none | `name ASC` | an Owner deciding to add a supplier |
| `GET /categories` | `CategoriesService.findAll` | none | `name ASC` | an Owner deciding to add a category |
| `GET /users` | `UsersService.findAll` | none | `id ASC` | an Owner deciding to add an account |

**Phase 9 gave a reason for capping `/audit-events` that was true but narrower than
necessary** — *"this table grows without any user doing anything, from every failed
login anywhere on the internet."* The stronger form, which was already true on the day
Phase 9 shipped, is: *a read whose result size is a function of how long the business
has been running is unbounded, and which mechanism does the growing is irrelevant to
that.* `inventory_transactions` qualifies under the stronger form and always did;
`audit_events` was merely the first table where an adversary rather than a customer
supplied the rows, which is what made it visible. Acting on the narrow form is what
left the two transaction reads uncapped for two phases. Recorded here because this
file's job is to notice when a stated reason was doing less work than the real one.

**The four catalogue reads are left uncapped deliberately, and that is a third named,
unenforced precondition of the same shape as the two already in this file** (the
in-memory throttle store; the best-effort audit write): *this business will not
accumulate more products, suppliers, categories, or users than one response can carry.*
Nothing checks it, and nothing reports it failing — a Product List of a few hundred
rows just gets slower. It is not bounded here because a truncated catalogue is a
*wrong answer* where a truncated log is a *reading position*: capping a catalogue
honestly needs a total, a next page, or a rethink of the screen's filters — a paging
design, deferred with a concrete trigger (`docs/phase-11-plan.md` §7). There is also a
mechanical reason a naive `LIMIT` cannot go on `/products`: `ProductsService.findAll`
filters `status=low`/`status=out` in application code *after* the SQL runs, because
both depend on current stock, so a pushed-down `LIMIT` would take the first N products
by name and only then filter.

That this file now holds **three** preconditions of one shape — correct at this
project's scale, silently invalidated by growth or by a second process, never checked
— is itself the observation: it is the pattern this codebase reaches for, not three
coincidences.
