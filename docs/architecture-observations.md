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
