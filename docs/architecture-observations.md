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

**A known, deliberately deferred question**: all of these audit columns are plain
`TIMESTAMP` (no timezone), matching the four that existed before Phase 7 rather than
introducing a second convention mid-schema. There's a real argument that server
timestamps should be `timestamptz` throughout — the current plain `TIMESTAMP` columns
are implicitly server-local/UTC by convention, not by an enforced type — but that's a
schema-wide migration touching every existing audit column at once, not something to
decide as a side effect of adding two tables' worth of columns. Parked here as a
known latent question, not resolved.

**[Updated 2026-08-25, Phase 9]** Deferred a third time (Phase 8 §1 declined to
reopen it; `docs/phase-9-plan.md` §1 defers it again), and each new table makes the
eventual migration one table wider. The exact list, so the next person deciding has
one instead of an impression — every plain `TIMESTAMP` column in the schema as of
Phase 9, ten pre-existing plus one new:

- `products.created_at`/`updated_at`, `suppliers.created_at`/`updated_at` (`InitSchema`)
- `inventory_transactions.created_at` (`InitSchema`; contrast `occurred_at`, `timestamptz`, above)
- `users.created_at`/`updated_at`, `categories.created_at`/`updated_at` (Phase 7)
- `users.locked_until` (Phase 8 — operational state, not an audit column, but the
  same plain-`TIMESTAMP` convention; see that migration's own comment)
- `audit_events.created_at` **[new, Phase 9]**

Eleven columns across six tables, up from ten across five before this phase. It has
only grown, never shrunk, every phase since Phase 7 first parked the question.

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
