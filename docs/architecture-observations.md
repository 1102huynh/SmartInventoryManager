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

*(Phase 14 update: the four catalogue rows gained an **optional** `?page=&pageSize=`
and a paged envelope; the default — no param — is still the full array. See the
Phase 14 section below for why the precondition is only **partly** retired.)*

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
coincidences. *(Phase 14 retires the tractable part of the catalogue-reads one — every
list **screen** is now paged and the routes accept a page — but the three routes with
a whole-set second consumer still return the full set by default, so it drops to
**two-and-a-half**, not two. Phase 17 then closes it for `GET /products` and
`GET /suppliers` by making their pickers search-as-you-type: neither route has a
whole-set caller any more. It survives only on `GET /categories` via the `CATEGORIES`
reference cache, which is deliberately left unbounded — see the Phase 17 section
below.)*

## Cross-cutting: the module seam's first real test, and a convention reused by reference (Phase 12)

Phase 12 (`docs/phase-12-plan.md`) added adjustment approval: a new `AdjustmentsModule`
with its own entity, controller, and workflow.

**The module seam held.** Phase 2's Go-extraction note above names `InventoryModule`'s
zero dependencies as the seam an extraction would use. Phase 12 is the first genuinely
new concern to arrive since then that *could* have been dropped into `InventoryService`
— an approval workflow is domain logic, and it needs the row lock `recordAdjustment`
already takes. It was put in a module that **depends on** `InventoryModule` instead:
`AdjustmentsModule → InventoryModule`, never the reverse, the same direction
`ProductsModule` and `DashboardModule` already point. `InventoryService` gained exactly
one new public method (`applyApprovedAdjustment`, the extracted body of
`recordAdjustment`) and lost none; `POST /products/:id/adjustments` moved to
`AdjustmentsController` (the path is unchanged — Nest routes by decorator). So "the
`InventoryModule` depends on nothing" property stays literally true, and the seam is one
data point stronger for having been tested rather than only asserted.

**Phase 11's bounded-read convention was reused without re-derivation.** `GET
/adjustment-requests` is the fifth bounded read. The bound (`@Min(1)`/`@Max(500)`,
default 100 as a service constant), the `X-Result-Truncated` header via the shared
`trimToLimit`, the `created_at DESC, id DESC` ordering, and — the one that would have
been invisible to get wrong on this UTC+7 machine — the correct one of the two `?days=`
cutoffs (`daysCutoffForInstantColumn`, because `created_at` is a real instant) were all
applied by reference to `docs/phase-11-plan.md` §1 and the existing `/audit-events`
code. Phase 11's implicit claim was that writing the decision down once would make the
next list read cheap; this is the first evidence either way, and it held.

**The three named unenforced preconditions above are unchanged in number by this
phase.** Phase 12 adds a table that grows with the business forever
(`adjustment_requests`) but bounds its one read on arrival, so it joins the log side of
the ledger, not the "silently invalidated by growth" side.

## Cross-cutting: the frontend's first structural phase (Phase 13)

Phase 13 (`docs/phase-13-plan.md`) split `frontend/index.html` — a 3,061-line single
file: a 284-line `<style>` block and one `<script>` holding a config layer, `Auth`,
the `Store` API client, the `UI` helpers, the router, and sixteen `Views.*` functions
— into `styles.css` plus a graph of small ES modules (`config`, `session`,
`reference-data`, `ui`, `api`, `router`, `main`, and nine `views/*.js` grouped by
resource). **No behaviour changed**; the correctness criterion was that the app after
the split is the app before it.

**The observation worth recording is why one file was right and then wasn't — two
different facts about the same file.** `frontend/index.html` was written in Phase 1 as
a *navigable mockup*, and for a throwaway that existed to validate workflows against
`product.md` before any server existed, one file was exactly right. It was never
rewritten; instead ten consecutive backend phases (3, 5, 6, 9, 11, 12) each reached
into it and added a screen or a gate, and the mockup silently became the product. The
project noticed the second fact only when a phase was finally *about* the frontend —
the same shape as this file's other entries, where a stated reason (Phase 9's cap on
`/audit-events`; the plain-`TIMESTAMP` convention) was doing less work than the real
one until something forced a closer look. The frontend's structure had been invisible
because no phase had ever been about it.

**Two decisions a future reader will re-litigate:**

- **Native ES modules over a bundler, on `serve.js`'s own stated grounds.**
  `serve.js`'s comment is the project's frontend creed — the frontend needs a real
  HTTP origin but *not* a framework or a toolchain, "just enough to serve
  `index.html` over HTTP." A bundler would delete that reason to exist and replace it
  with the exact class of thing it was written to avoid (a build step, a dependency
  tree, a config surface), to solve a problem browsers solved natively years ago.
  **The concrete trigger that would flip this** (`docs/phase-13-plan.md` §7): the
  first time this frontend is deployed over a real network where the native-module
  request waterfall measurably hurts first paint — then a bundler is a
  deployment-time optimisation of an already-modular codebase, which is the state
  this phase leaves it in. A framework (React/Vue/Svelte) was rejected outright: it
  is a rewrite, not a restructuring, and its own multi-phase project if ever wanted.
- **The frontend now decomposes by the same resources the backend does.** Nine view
  files — `products.js`, `suppliers.js`, `users.js`, `transactions.js`, `audit.js`,
  `approvals.js`, … — each mapping to a nav section and to a backend module
  (`ProductsModule`, `AdjustmentsModule`…). "One file per view" (sixteen files) was
  declined as the frontend equivalent of a per-method file. A reader who knows the
  backend's shape now knows where a screen lives.

**`serve.js` was byte-for-byte unchanged.** A reader will check whether a file split
forced a server change; it did not, because static files are static files — its
`path.join(ROOT, …)` plus the `../` guard serves `/views/products.js` with no edit.
That the server written to "serve one HTML file" serves a module graph untouched is
itself evidence the split respects the frontend's existing shape rather than fighting
it.

**Shared mutable state across module boundaries** (`session.js`, `reference-data.js`)
is the one place the single-file design was doing something that did not survive the
split unchanged: `CURRENT_USER` / `ACCESS_TOKEN` / `CATEGORIES` were module-level
`let`s one function mutated and another read. An imported binding is a live,
read-only view, so the naïve "move the `let`, import it everywhere" breaks loudly for
the writers. The fix is accessor functions (`getCurrentUser`/`setCurrentUser`/
`clearSession`, `getCategory`/`setCategories`), not a shared mutable object — the
latter re-creates unrestricted mutation of shared state, now invisible across a file
boundary instead of visible within one. The writers are greppable: `setCurrentUser`
has two callers (`Store.login`, `Store.logout`, plus the 401 path's `clearSession`),
the same reason BR-082 keeps `actor` and `subject` as two explicit columns.

**No automated frontend test was added.** The frontend has no test runner, no jsdom,
no Playwright — by the same minimalism that kept it one file — and this phase did not
add one: that is real dependency and tooling cost (the thing a bundler was rejected
for), it is not this phase's subject, and bolting it on here would entangle "did the
split preserve behaviour" with "does the new harness work." Verification was a manual
smoke walk against a byte-identical pre-split baseline plus two mechanical invariants
(the inline-handler grep stays at zero; the console stays clean). **The trigger**
(`docs/phase-13-plan.md` §7): the first phase that adds genuinely new frontend
*logic* rather than relocating existing logic should add the harness to cover its own
new behaviour.

## Cross-cutting: continuous integration, and the preconditions it made explicit (Phase 15)

Phase 15 (`docs/phase-15-plan.md`) added `.github/workflows/ci.yml` — lint, the
unit + integration suite, and the e2e suite, each on a clean `postgres:17` service
container, on every push and pull request. No application code, no test, no migration
changed; the workflow runs the suite that already existed.

**For twelve phases "the suite is green" was a fact about one machine.** Every plan
since Phase 3 ends its "Definition of done" with a line of the shape *"full backend
suite green — unit, integration, and all e2e specs,"* and that green was produced by
one person running `pwsh tools/pg-start.ps1` and two `npm` commands by hand. The suite
carried unstated preconditions — the portable Postgres running, `smart_inventory_test`
and `smart_inventory_e2e` existing, `migration:run` already applied to the e2e
database — none of which was written anywhere as a runnable step (`README.md` documented
the *dev* database only). This is the same shape as this file's other entries: a
correctness property (Phase 8's single-process throttle, Phase 10's `TIMESTAMP`
write/read zone) that held at this project's scale and was never named as something
that *could* stop holding. The workflow is the artefact that names these — a
reviewer now reads `ci.yml` and sees exactly what "green" requires.

**Wiring CI immediately surfaced that the lint step was never CI-clean.** `npm run
lint` is `eslint --fix` — it rewrites files rather than checking them — and running it
once during implementation reformatted about a dozen unrelated files (prettier
line-wrapping only) and still reported six errors it cannot auto-fix (unused imports
and `no-unsafe-call` in three spec files). Those errors predate Phase 15 by many
phases; every "full suite green" in a DoD checklist meant the tests, never a clean
lint, because `--fix` silently rewrites on each local run and the residual errors
scroll past. Handled without widening the phase: the `lint` job gates on `nest build`
(the clean typecheck) and runs eslint as a non-blocking informational step; a real
lint gate — a `--fix`-free script plus fixing the errors — is a follow-up
(`docs/phase-15-plan.md` §7).

**[Phase 16, `docs/phase-16-plan.md`] — the lint step went from informational to
blocking.** A clean check-mode run turned out to be 29 errors across ~15 files, not the
six the mid-`--fix` count showed: 24 auto-fixable (prettier wrapping, two redundant
`as` casts), and — after `--fix` — six manual (four `no-unsafe-call` on supertest
response bodies, two orphaned imports/vars). What "clean" required:

- **A mechanical `eslint --fix` sweep**, committed alone as `style:` so its 12-file
  diff reviews as formatting and never rides with a behaviour change (the rule Phases
  12 and 13 applied to their refactors). Two migration files were touched — a
  class-declaration line-wrap only; `up()`/`down()` are byte-unchanged and nothing
  re-ran.
- **One rule relaxed in the existing test-file override**:
  `@typescript-eslint/no-unsafe-call: 'off'` joins its four `unsafe-*` siblings under
  `files: ['**/*.spec.ts', 'test/**/*.ts']`, on the rationale the block's own comment
  already makes — a call on `res.body` from supertest is `any` by the nature of the
  boundary. Confirmed still active in `src/`.
- **`.gitattributes` (`* text=auto eol=lf`)** so a lint run is byte-deterministic
  across a Windows dev box (`core.autocrlf=true`, CRLF working tree) and the Linux
  runner. `git add --renormalize .` produced no content change — the blobs were
  already LF.
- **A `lint:check` script** (`eslint` with no `--fix`) for CI; `lint` stays `--fix`
  for the local fix-on-save habit. The `ci.yml` eslint step runs `lint:check` and its
  `continue-on-error` is gone.

**Branch protection is now on `develop`** (issue #6, after Phase 16 made a permanently-red
lint check the last obstacle). Required status checks: `lint`, `test`, `e2e`; a pull
request is required with 0 approvals, so the solo author still self-merges but nothing
merges red. `enforce_admins` is off — the author can push directly in a pinch — and the
`frontend` job is deliberately not required. It was flipped ahead of Phase 15 Fork F's
stated trigger (a second contributor) because the cost of doing so early is nil once the
checks are trustworthy. `docs/phase-16-plan.md` §7 carries the exact settings.

**CI is the first thing that runs the migration chain against an empty database.**
Phases 10 and 12 shipped migrations; a local `smart_inventory` / `smart_inventory_e2e`
has had every migration applied incrementally, in order, over months. A migration that
only works *against the schema the previous migration happened to leave* — a dropped
`IF NOT EXISTS`, an implicit column order, a value that a prior data migration wrote —
would never surface there. The `e2e` job does `createdb` then `npm run migration:run`
from nothing on every push, so it would. If that step ever goes red, it has found a
real defect in the migration chain, not a CI problem (`docs/phase-15-plan.md`
§"why now", §5).

**Two version pins, each a previously-ambient fact made explicit:**

- **`postgres:17`**, not `postgres:latest`. The two version-sensitive spots are the
  `timestamptz` conversion migration (Phase 10) and the `SELECT … FOR UPDATE`
  concurrency test in `inventory.service.integration.spec.ts` — a green suite on a
  different major would hide a regression in either. `tools/README.md` already pinned
  "PostgreSQL 17.6" for local dev; CI now matches it.
- **Node**, via a repo-root `.nvmrc` and a `backend/package.json` `engines` field —
  neither existed before this phase, and CI picking its own version would have been one
  more unstated precondition. The pin is **`24`** (`>=24 <25`), which is the version the
  project's developer already runs locally, **not** the active LTS (22) that
  `docs/phase-15-plan.md` §1 Fork G recommends. That is a deliberate owner choice,
  recorded here per the fork: keeping local and CI identical was judged to matter more
  than tracking LTS, and the pin is a one-line change if that trade is revisited.

**What this phase deliberately did not do**, so a reviewer does not read the absence as
an oversight:

- **No branch protection / required status check.** That is a GitHub *repository
  setting*, not a file in the repo, and Phase 15's CI still had a permanently-red lint
  check that made it impossible anyway. *Done later:* Phase 16 fixed the lint check and
  issue #6 flipped protection on `develop` (`lint`/`test`/`e2e` required, PR required,
  0 approvals) — see the Phase 16 addition above.
- **No deploy pipeline.** This workflow is CI, not CD. It runs entirely on throwaway
  values — the same dev defaults as `backend/.env.example`, no GitHub Actions secret
  anywhere. A deploy job would need real secrets and an environment target; that is a
  separate decision gated on this app being hosted somewhere real (§7).
- **No Node version matrix.** One application, one deploy target — a matrix is for a
  library that publishes to many runtimes (Fork G).
- **No coverage gate**, no build/dependency caching beyond `setup-node`'s npm cache, no
  jest sharding. The suite is minutes; optimise when it hurts (§7).

**The learning-notes gap this phase named — reconciled against the history.**
**[Corrected 2026-09-07, issue #5.]** This entry, `docs/phase-15-plan.md` §7, and
`docs/phase-16-plan.md` §7 all record `docs/learning-notes/` as "frozen at Phase 8"
(`9649e0e`), with Phases 9–14 adding substantial material "with no note." The commit
history does not bear that out — each phase since 9 documented its own subject in the
notes as part of its `feat` commit:

- **Phase 9** (`7f93fb0`) — `cross-cutting-concerns.md` (new: global interceptor vs.
  TypeORM entity subscriber vs. explicit service call) and the actor/subject section
  in `authentication-and-guards.md`. The best-effort audit write is documented in
  *this* file, above (the in-memory-throttle-store entry), per `docs/phase-9-plan.md`
  §4 — it was routed here deliberately, not to a learning note.
- **Phase 10** (`452672f`) — the `timestamp` vs. `timestamptz` section in
  `database-access.md` and the `TZ`/Jest-bootstrap trap in `testing-strategy.md`.
- **Phase 11** (`8eb2471`) — the `take` / `addOrderBy` / `limit + 1` probe section in
  `database-access.md`.
- **Phase 12** (`7bc90d0`) — the role- vs. ownership-based authorization rule in
  `authentication-and-guards.md` and the cross-module transaction in
  `database-transactions.md`.
- **Phase 15** (`14646d6`) — `ci-and-environments.md` (new).

**Phase 13's frontend module architecture** was the one item on the original list with
no learning note — `docs/phase-13-plan.md` §4 made that note explicitly optional, with
the structural account here, above ("the frontend's first structural phase"). Issue #5
added it: `docs/learning-notes/frontend-module-architecture.md` (native ES modules over
a bundler, the live-binding trap and accessor pattern, resource-grouped view files) —
the folder's first note about the frontend rather than the NestJS backend. The
retro-documentation `docs/phase-15-plan.md` §7 anticipated is therefore done,
incrementally by the phases themselves plus that one note. The two plan §7s are left as
the historical snapshots they are.

## Cross-cutting: catalogue paging, and a precondition partly retired (Phase 14)

Phase 14 (`docs/phase-14-plan.md`) gave the four catalogue list reads
(`/products`, `/suppliers`, `/categories`, `/users`) an **optional** `?page=&pageSize=`
and a `{ items, page, pageSize, total }` envelope, gave every list *screen* a
Prev/Next control, moved the Product List's `low`/`out` filter into SQL, and added the
frontend's first automated test. It landed after Phase 15 in wall-clock — CI was built
first — but is numbered before it. **No migration.**

**The unbounded-catalogue-reads precondition (this file's third, named in the Phase 11
section) is only *partly* retired — deliberately, and the reason is a repository fact
the tidy version of this phase does not survive.** Three of the four routes have a
*second consumer that needs every row*: `GET /products` feeds the stock/adjustment
wizard's product picker and the category screen's product-count read; `GET /suppliers`
feeds the stock-in wizard's supplier picker; `GET /categories` feeds
`Store.loadReferenceData`, the global `CATEGORIES` cache every product form's dropdown
reads. A picker silently capped at 50 is a **correctness cliff** — a user cannot record
a movement against product #51 — not a slow screen. So the routes stay unbounded *by
default* (the bare array), and paging is something a caller opts into; only the list
screens do. What is genuinely retired: every list screen is now bounded, the routes
*can* be bounded by any caller that wants a page, and `GET /users` — the one with no
second consumer — could be made non-optionally paged (Fork D) if a reviewer prefers.
**Two-and-a-half of the original three preconditions, not two.** The trigger that would
close the rest is named in `docs/phase-14-plan.md` §7: making the pickers
typeahead/search-as-you-type controls that query a paged, searchable route — a UX
change to two wizards and a screen, with its own justification, not a rider here.

**Offset pagination, not keyset — and the Phase 11 reason against `?offset=` does not
transfer.** Phase 11 §7 refused `?offset=` for the log reads because *"a table where
new rows arrive at the top"* ships the classic skipped-row bug the instant an offset
page is turned while a row is inserted above it. A catalogue is the opposite table: it
is ordered `name ASC` (a stable key that does not move), rows are added one at a time
by a person choosing to add one, and it grows a few times a week. The skipped/
duplicated-row window still exists in principle but needs someone to insert a product
named "Mango" in the seconds another user takes to click Next — a tolerable window
where the log feed's was not. Offset also buys the two things a catalogue UI wants and
keyset cannot give cheaply: a real `total` ("Page 3 of 12 · 573 products") and
random access to the last page. `getManyAndCount` / `findAndCount` (and, for the
products query, `getCount` + `getRawAndEntities`) issue one extra `COUNT(*)` over the
filtered set — a few-hundred-row scan here, the exact scan Phase 11 §1 refused for the
logs *because there the filtered set was the whole transaction history*.

**The envelope/header asymmetry is deliberate, not an inconsistency to iron out.** Log
reads return "recent N + filters + `X-Result-Truncated`" — a *reading position*;
catalogue reads return "page N of a total" — a *page of a whole*. Phase 11 §1's "a cap
on a log is a reading position; a cap on a catalogue is a wrong answer" is now made
concrete in two response shapes. The envelope is catalogue-only and appears **only**
when a paging param is sent; every other caller — the pickers, the reference cache —
gets the byte-for-byte-unchanged bare array, which is what let this phase ship without
touching three wizards.

**Fork B moved "the most load-bearing query in the app" and shipped no migration.**
`ProductsService.findAll` used to run its SQL, then filter `status=low`/`out` in
application code (current stock is a `SUM(quantity_delta)` the `WHERE` clause could not
see) and fire two more round-trips for the stock and history maps. It now computes
current stock and `hasHistory` in the read itself via a grouped subquery join over
`inventory_transactions` (backed by the existing `product_id` index —
`IDX_2520d97de0c9a0fbfc9b00f4c1`), so `low`/`out` are real `WHERE` conditions and
`?status=low&pageSize=50` pages the low-stock set instead of taking 50 products by name
and *then* filtering. This is exactly the change Phase 11 §7 predicted this trigger
would force ("moving the low/out filter into SQL"), done deliberately and
`EXPLAIN`-sane. **A reviewer arriving from Phases 11 and 12 — each of which shipped a
migration — will look for one; there is none.** It is a query rewrite and additive
query params, nothing in the schema.

**Phase 13 §7's frontend-test trigger fired here, as that plan said it would.** Phase
13 named "the first phase that adds genuinely new frontend *logic* rather than
relocating existing logic" as the one that should add the test harness for its own
behaviour. Paging is that logic — `page` state, reset-to-1-on-filter-change, disable
Prev/Next at the ends, the off-by-one-prone `Math.ceil(total / pageSize)`. What was
added, kept small: `frontend/pager.js` (the pure arithmetic, `pagerModel`), a first
`frontend/package.json` with one devDependency (`jsdom`), and `frontend/test/` with a
pure `pager.test.js` and one jsdom `products-list.test.js`; `npm test` runs
`node --test`. No bundler, no build step, no config — and `serve.js` stays CJS and
byte-for-byte unchanged because the new `package.json` carries no `"type"` field
(Node reparses the `.js` modules as ESM on its own). This is the frontend's first
`node_modules`, resisted since `serve.js` was written and by Phase 13 for a *bundler*;
a `node --test` harness is not a bundler, and "the first real frontend logic ships
untested" is the outcome Phase 13 §7's trigger exists to prevent.

## Cross-cutting: the unbounded-read precondition closed for two of three routes (Phase 17)

Phase 17 (`docs/phase-17-plan.md`) did the work Phase 14 §1/§7 named as its successor:
the three catalogue reads that still fetched every row for a non-screen caller are
gone. The stock-in wizard's supplier field and the Inventory History product filter
are now search-as-you-type controls (`frontend/typeahead.js`) that query
`GET /suppliers?search=&status=active` and `GET /products?search=` a page at a time;
the Categories screen's client-side product count is a server-computed `productCount`
on the paged `GET /categories` read.

**The precondition is retired for `GET /products` and `GET /suppliers`, and survives
only on `GET /categories`.** After this phase, grep finds no caller of `listProducts`
or `listSuppliers` that omits a paging param — the list screens page, the pickers
search-and-page. `GET /categories` still has one whole-set caller,
`Store.loadReferenceData`, which fills the `CATEGORIES` cache every product form's
category `<select>` reads. That one is **left unbounded on purpose** (Phase 17 Fork D):
categories are a small, slow-growing, fixed set — `npm run seed` makes five, a real
small business a dozen — and a `<select>` of a dozen options is the right control; a
typeahead over it would be worse UX for no gain. So the count on this file's
three-preconditions ledger goes from *two-and-a-half* (Phase 14) to *two-and-a-sliver*:
the throttle store and the best-effort audit write are untouched, and the
catalogue-reads one is down to a single route whose set is bounded in practice by what
a shop is. `DashboardService.find()` is a separate whole-catalogue read (issue #9), not
this precondition — a `lowStockCount` summary inherently needs every product. **Phase
19 addressed that read** (see this file's Phase 19 section): still every product, but
now in one query, not two.

**The category count reused Phase 14 Fork B's pattern exactly, and shipped no
migration.** `CategoriesService.findAll`'s paged branch went from `findAndCount` to a
query-builder read with a grouped subquery `leftJoin` over `products` + `addSelect` +
`getRawAndEntities` — the same shape `ProductsService.findAll` uses for current stock.
The no-param branch is untouched, so the `CATEGORIES` reference-cache response is
byte-for-byte what it was (asserted, in both the integration and e2e specs, that the
bare array carries no `productCount` key). `products.category_id` is already indexed by
the `InitSchema` foreign key, so the join has support. **A reviewer arriving from
Phases 11, 12, and 14's migration notes should note: Phase 14 shipped no migration and
neither does this — a computed column in a read is not a schema change.**

**`frontend/typeahead.js` is the second frontend module with real behaviour and its
own test, after `pager.js` (Phase 14).** It is a module rather than a `UI.*` helper for
the same reason: `UI.pager` / `UI.truncationNotice` are pure markup functions, while
this holds live state (the committed selection, an in-flight request sequence) and
attaches listeners, and two views share it. The behaviour worth a test — a debounce, a
stale-response guard that drops a superseded query's result, "revert the visible text
to the committed selection on blur" — is DOM-and-async, not arithmetic, so it is
covered directly with jsdom (`frontend/test/typeahead.test.js`), not split into a pure
core the way `pager.js` was (Phase 17 Fork C). Every listener is attached by the
factory to an element it created — the Phase 13 "no inline `on*` handler" invariant,
now also observed by a module that builds its own DOM.

## Cross-cutting: a fourth enum column, and a nullable one with no backfill (Phase 18)

Phase 18 (`docs/phase-18-plan.md`) resolves `product.md` Q-4 by adding
`inventory_transactions.reason_category` — an optional structured "why did this stock
leave" from a fixed seven-value set (FR-025, BR-023). It is the fourth per-table
Postgres enum in the schema, after `inventory_transactions_type_enum` (InitSchema),
`users_role_enum` (Phase 5), and `users_status_enum` (Phase 6), and it follows their
`CREATE TYPE … AS ENUM(...)` shape exactly.

**Two things make it a lighter migration than Phases 5, 6, 11, or 12's.** It is
purely additive — one `CREATE TYPE`, one `ADD COLUMN`, one `ADD CONSTRAINT`, with a
`down` that reverses all three — so a reviewer arriving from the Phase 10 converting
migration or the Phase 12 table-creating one will find nothing to be careful about.
And it is deliberately **nullable with no default and no backfill**, unlike
`AddUserStatus`'s "backfill every row to `'active'`, then `SET NOT NULL`". A stock-out
recorded before this phase, or one recorded without a category (FR-021 is unchanged —
the reason has always been optional), genuinely has no category; `NULL` says exactly
that, and there is nothing sensible to backfill it to. The consequence: no existing
row, seed, integration fixture, or e2e expectation had to change, and the
`InventoryTransaction` response shape is a strict superset of what it was.

**The `@Check` is the BR-023 guard, and lives in three registries like the
`occurred_at` index.** `type = 'stock_out' OR reason_category IS NULL` — a reason
category is meaningful only on a stock-out — is written by hand in the
`1787930000000` migration (name `CHK_inventory_transactions_reason_category_stock_out`)
for dev/prod, and built from the entity's class-level `@Check` decorator in the
`smart_inventory_test` database (`test-data-source.ts`, `synchronize: true`) under a
generated `CHK_<hash>` name. The two are the same predicate under different names —
the same expected, documented difference the `@Index(['occurredAt', 'id'])` comment
describes for its DESC/ASC split. `InventoryService` never sets the column on a
stock-in or adjustment insert, so the `@Check` is a backstop, not a load-bearing
validation — proven by an integration test that raw-`INSERT`s a `stock_in` row with a
category and asserts the database rejects it.

**No read-path change.** Both history reads (`GET /products/:id/transactions`,
`GET /inventory-transactions`) already `getMany()` full entities, so the new scalar
column serialises onto every transaction response with no query-builder edit — in
contrast to Phase 14's `productCount` / current-stock computed columns, which needed
`getRawAndEntities` plumbing because they are not stored.

## Cross-cutting: the Fork B stock join becomes a shared helper (Phase 19)

Phase 19 (`docs/phase-19-plan.md`, issue #9) is the follow-on Phase 14 §7 named in so
many words: `DashboardService.getSummary` stopped reading the whole catalogue with
`productsRepository.find()` and then making a *second* trip
(`inventoryService.getCurrentStockMap(everyId)`) to attach current stock. It now runs
**one** query — products plus a `currentStock` column — the same grouped-subquery
`SUM(quantity_delta)` join Phase 14 Fork B built for `ProductsService.findAll`.

**This is the instance where the join got extracted rather than copied.** Phase 17
needed the *pattern* for a different table and aggregate (`COUNT(*)` over `products`)
and deliberately re-typed it into `CategoriesService.findAll` — an analogy, not a
duplicate. Phase 19's caller wants the *identical* SQL `findAll` runs, so a third
verbatim copy of one fragment is exactly the case for a helper:
`backend/src/inventory/stock-aggregate.query.ts` exports `joinCurrentStock(qb,
productAlias?)` — it adds the `leftJoin` subquery and the `currentStock` `addSelect`
and returns the builder — plus `STOCK_AGG_ALIAS` / `CURRENT_STOCK_EXPR` so a caller can
write its own expressions over the aggregate without restating the alias.
`ProductsService.findAll` now calls it; its `hasHistory` select and its
`status=low` / `status=out` `WHERE` conditions layer on top, unchanged. Generated SQL
is identical — `products.service.integration.spec.ts` passes unedited. **`CategoriesService`
was left on its own copy**: it joins `products`, not `inventory_transactions`, so
folding it through this helper would be a forced fit (the `getCurrentStockMap`-style
method `getHasHistoryMap` that Phase 14 *did* delete is the precedent — remove a
round-trip, don't over-unify).

**The dashboard summary response is byte-for-byte unchanged**, and the whole e2e suite
passes with no edit — the Phase 11 §5 rule (a diff in an unrelated spec here would be a
real regression, not a fixture artefact) is what proves it. The one deliberate
behaviour change is invisible at that scale: `getSummary`'s product read gained
`ORDER BY name ASC` (it had no `ORDER BY` before), so when *more than five* products
are low-stock, `needsAttention` is now "the first five by name" instead of five in
whatever order an unordered scan produced — the same determinism improvement Phase 11
made for `recentActivity`'s `id` tie-break, stated not glossed.

**Still no migration** (the fourth phase running — 14, 17, and now 19, with 18 the
exception — where a reviewer arriving from the Phase 11/12 migration notes should note
there is nothing to run). A `SUM` computed in a query is not a stored column;
BR-040/042's "current stock replays from history, never cached" is reaffirmed, not
bent. What is *not* done: `getSummary` still makes three DB calls total (the
products+stock query, then Phase 11's bounded `listAll({ limit: 8 })` and
`countSince(7)` over `inventory_transactions`) — those are cheap bounded reads over a
different table and merging them in buys little (§7).

## Cross-cutting: the last Phase 1 mockup scaffolding is deleted (Phase 20)

Phase 20 (`docs/phase-20-plan.md`, issue #10) removes `UI.mockFetch`,
`UI.previewControl`, and the per-view `?state=` / `override` handling from `frontend/` —
the navigable-mockup machinery Phase 1 used to preview empty and error panels with no
server, which ten backend phases then carried along and Phase 13 split out *unchanged*.

**This is a trigger firing exactly as it was written.** Phase 13 §7 did not defer this
deletion vaguely — it named the condition ("when someone decides the real backend's error
and empty states can be exercised another way in development") and the reason for waiting
("deletion is a behaviour change and this phase makes none"). The condition was already
true when Phase 13 shipped — stopping `serve.js`'s upstream API produces the real error
panel, an empty database or a non-matching filter produces the real empty panel — so the
four phases after it (14–17) and Phase 18 that re-listed this as "out of scope, Phase 13
§7" were each re-deferring with *no new information*, the move this project's standard
rejects. Phase 19 is the precedent: it did the follow-on Phase 14 §7 had named and left
sitting. Phase 20 does the one Phase 13 §7 named.

**The scaffolding was never dev-gated, because the frontend has no build step**
(Phase 13's native-ES-modules decision, Fork A2). `previewControl` rendered a dashed
"Preview state" `<select>` — *Normal / Loading / Empty / Error* — into the toolbar of six
production screens. "Not part of the real product" (its own source comment) was true of
its intent and false of its reach; that gap is what a deletion, not another relocation,
closes.

**What the six `load()` functions looked like, and look like now.** Each read through
`UI.mockFetch(factory, { forceState })` — a wrapper whose only surviving job was to add a
microtask tick and to reject with a canned string when `forceState === 'error'` — and
each `factory` branched on `override === 'empty'` to return a hard-coded empty payload.
Removing the caller leaves `Store.x().then(render).catch(errorState)`, which is what the
views for the two resources that never had the scaffolding (`categories.js`, `users.js`)
already do. The "guarantee a Promise even if the factory returned a literal" reason the
wrapper documented for itself evaporates once the `override === 'empty'` literal is gone
and every path is an `async` `Store.*` call.

**One piece of real behaviour was preserved, not deleted with the scaffolding.** The
`override === 'empty'` ternary also chose between two genuinely different empty-state
messages — "No products yet / add your first" versus "No matching products / clear the
filters". Those are worth keeping, so each screen now derives which to show from whether a
filter is actually narrowing the list (`!search && !category && status === 'all'` on
products, the analogous check on each other view). The mockup control was faking a choice
the app can make for itself.

**Frontend-only, and no new test.** No backend file, no `serve.js`, no route, no
migration — the ninth "no new BR" line, the tenth "no new FR" note. The existing
`node --test` suite (28 tests) passes unedited: `products-list.test.js` stubs
`Store.listProducts` and drives the view's real `attach()` wiring, and the view now
awaits that stub directly. Phase 13 §7's *other* frontend trigger — a test harness for
new frontend logic — stays unmet on purpose: a deletion introduces no behaviour to cover,
and the empty/error panels themselves did not change.

## Cross-cutting: the throttle store's precondition is closed — the first of three (Phase 21)

Phase 21 (`docs/phase-21-plan.md`, issue #11) gave `@nestjs/throttler` a shared,
Postgres-backed store (`throttle_hits`, a custom `ThrottlerStorage`), replacing its
default per-process `Map`. The owner confirmed the trigger the "two rate-limiting
mechanisms" section above wrote down — "if this app is ever deployed with more than one
running instance in front of the same clients" — is met: a multi-instance deployment is
planned.

**This is the first of this file's three named unenforced preconditions to be *closed*
rather than carried.** The Phase 11 section counted three ("the in-memory throttle
store; the best-effort audit write; this business will not accumulate more products …
than one response can carry"), and the Phase 14/17 sections whittled the catalogue-read
one down to "a sliver" without ever removing an item. Phase 21 removes one outright: the
throttle count now lives in the same Postgres as account lockout, the audit log, and
every entity, so the "silently becomes per-instance under a second process" failure mode
the Phase 8 section describes no longer exists. The other two — BR-082's best-effort
audit write and the unbounded `GET /categories` reference-cache read — are untouched.
Like Phase 10 closing the `timestamptz` question, this is an entry that finally shrinks
the ledger rather than growing it.

**Two deliberate divergences from the default store, documented so a reviewer reading
the two side by side sees they were chosen:**

- **Fixed window, not per-hit sliding expiry.** The stock `ThrottlerStorageService`
  schedules a `setTimeout` per hit that decrements the counter one `ttl` later; the
  Postgres store instead keeps one row per key (`hits`, `expires_at`) and resets `hits`
  to 1 on the first request after `expires_at` lapses. This is what the throttler
  ecosystem's Redis store does too (`INCR` + `PEXPIRE`), it is easier to reason about,
  and its boundary burst (up to `2N` across `2·ttl`) is within tolerance for a 120/60s
  backstop and a 10/300s login limit — the same "quantify the security cost, check it
  is small" move Phase 8 §1 made for the flat lockout window. `blockDuration` is treated
  as equal to `ttl` (nothing in this app sets a distinct one); a `blocked_until` column
  is where a real block period would go if a future phase configures one.
- **`UNLOGGED` in dev/prod, `LOGGED` under `synchronize`.** The migration creates
  `throttle_hits` `UNLOGGED` — no WAL for an ephemeral per-request counter, contents
  truncated after an unclean shutdown (the limits just reset for a few seconds).
  TypeORM cannot express `UNLOGGED` through decorators, so the integration test database
  (`test-data-source.ts`, `synchronize: true`) builds it `LOGGED`. Behaviourally
  invisible — durability and replication only, nothing a test asserts — and the same
  shape of expected, documented difference as the `@Check` constraint names (Phase 18)
  and the index DESC/ASC split.

**`throttle_hits` carries no `created_at`/`updated_at`**, and that is consistent with
§8's convention rather than an exception to it: the convention governs *audit* columns,
and a disposable counter the next request overwrites has no audit question to answer —
the same call as the missing `@UpdateDateColumn` on the immutable tables, for the
opposite reason. `expires_at` is server-set operational state, so `timestamptz`, per the
`users.locked_until` precedent.

**Race-free, unlike Phase 8's account counter.** `increment` is one
`INSERT … ON CONFLICT DO UPDATE`; Postgres row-locks the conflicting row, so two
simultaneous requests for one key serialise and increment to 2, never to 1-and-1. Phase
8 §1 explicitly accepted a lost-update race on `registerFailedLogin` because a row lock
was not worth it there; here the atomic upsert removes the race at no extra cost, so
this store does not carry that caveat.

**`trust proxy` moved from a deployment note to code.** Phase 8 §1 flagged, as "a
deployment note, not a code change," that `req.ip` is only honest if Express knows
whether it sits behind a proxy — and that behind an unconfigured load balancer the
throttle would treat the whole world as one client. Phase 21 makes that load-bearing:
the whole point is a throttle correct across instances, and multiple instances almost
always means a load balancer, so a *shared* store keyed on the balancer's one IP would
be a worse throttle than the per-instance one it replaces. `TRUST_PROXY` (env →
`configuration.ts` → `app.set('trust proxy', …)` in `main.ts`) is the fix; unset (the
default) keeps `req.ip` honest for a directly-connected local dev server.

**No FR, no BR** (the Nth of each): BR-079/BR-080 read exactly as before — where the
throttle keeps its count is not a business rule. **No `domain-model.md` entity**:
`throttle_hits` is an operational/cache table that models nothing in `product.md`.

## Cross-cutting: the opportunistic-prune pattern, used a second time (Phase 22)

Phase 22 (`docs/phase-22-plan.md`, issue #12) bounds `audit_events` to a rolling
one-year window — rows older than that are deleted by an opportunistic probabilistic
sweep on `AuditService.record()` (probability `0.001`, the exact rate
`postgres-throttler.storage.ts` uses) plus one unconditional pass on
`OnApplicationBootstrap`. It is the retention policy Phase 9 §7 deferred by name, with
the trigger that section wrote down — "a slow audit screen, or a backup size that
surprises someone" — now reported met.

**This is the same mechanism Phase 21 built for `throttle_hits`, applied to a second
table — and that repetition is itself the observation.** The Phase 11 section noted that
"three preconditions of one shape" was "the pattern this codebase reaches for, not three
coincidences"; the same is true here in the other direction. Faced twice with "a table
needs periodic bulk cleanup and this project has no scheduler," the answer both times
was a cheap `DELETE` piggybacked on the hot-path write that drives the table's growth,
guarded by a probability and backstopped at startup — never `@nestjs/schedule` (refused
in Phase 12 and Phase 21 Fork C2) or `pg_cron` (refused in Phase 21 §7). The pattern is
now a documented convention with two instances, the same way Phase 12 found Phase 11's
bounded-read convention reusable "without re-derivation." The two properties that make
it legitimate, and that a third use should be checked against: the work must **tolerate
being skipped** — its loss is bounded (`audit_events`: at most a slightly oversized
table until the next roll) or ephemeral (`throttle_hits`: the limits reset for seconds),
never a wrong answer — and it must be **cheap enough to be invisible** on the request
that happens to trigger it (one indexed `DELETE`, not `await`ed).

**The audit subsystem now has two best-effort, unmonitored background operations, not
one.** The Phase 9 section above named the best-effort *write* (BR-082 — a failed
`record()` is caught, logged, swallowed) as a precondition of the same shape as the
in-memory throttle store: correct at this scale, silently degrading if it stops holding.
Phase 22 adds the best-effort *prune* (BR-090) on the identical premise — a sustained
run of prune failures lets the table grow unbounded again with nothing surfaced where a
person would see it. Both are deliberate, both rest on "a 1–10 person business's audit
log is a *record, not a proof*," and both would want a real alarm or a durable queue at
a different scale. The startup prune is a partial backstop the write does not have:
every deploy clears whatever the probabilistic path missed.

**What Phase 22 does *not* touch.** It is not one of this file's three named unenforced
preconditions being retired — those are the in-memory throttle store (closed Phase 21),
the best-effort audit write, and the unbounded `GET /categories` reference-cache read.
Retention was a Phase 9 §7 deferral with its own trigger, not a precondition in that
ledger. But it closes the last *"grows without bound"* concern specific to
`audit_events`: Phase 9 capped the read, Phase 11 restated why that mattered, and Phase
22 caps the table the read draws from. `inventory_transactions` is deliberately left
unbounded — it is business history (BR-050/BR-051), kept for good, and
`domain-model.md` §8 now records that the two tables diverge here on purpose.

**No new FR** (the twelfth such note): FR-065 reads exactly as before. **One new BR**
(BR-090) with BR-082 amended — "how long the log is kept" is a statement about the
business, which is why it is a rule and the throttle-store change was not. **No
migration, no schema change**: the prune reuses `IDX_audit_events_created_at` from Phase
9, and `created_at` has been `timestamptz` since Phase 10. **No new configuration**: the
one-year window is a constant, the deliberate inverse of Phase 21's `TRUST_PROXY`
addition and consistent with Phase 9 §1's "the cap is a constant, not configuration"
call for this feature's sibling number.

## Cross-cutting: current stock stops being a read-time SUM (Phase 23)

Phase 23 (`docs/phase-23-plan.md`, issue #13) stores current stock as
`products.current_stock` and has `InventoryService.insertTransaction` rewrite it — from
the product's full `inventory_transactions` history, never `+= delta` — on every stock
write, inside the pessimistic product-row lock that already serialises writers (BR-041).
`ProductsService.findAll`, `ProductsService.findOne`, `DashboardService.getSummary`, and
`AdjustmentsService`'s stock reads all read the column now; the `joinCurrentStock`
grouped-subquery helper (Phase 19's careful single-copy extraction) is **deleted**.

**This closes the Phase 22 "cost is a function of how long the business has run" shape
for its last instance.** Phase 22's own section, and the Phase 9/11 sections it built
on, sharpened `audit_events`' retention argument into a general one: *a read whose cost
grows with the age of the business is unbounded, regardless of which mechanism does the
growing.* Phase 22 fixed that for `audit_events` by **pruning the table** and, in its
§7, named `inventory_transactions` as the table where that fix is unavailable — it is
business history (BR-050/BR-051), kept for good. Every `GET /products` and every
dashboard load ran a `SUM(quantity_delta) … GROUP BY product_id` over that whole,
ever-growing table (Phase 14 Fork B's subquery has no per-product filter). The only
remaining move for an unprunable table under an aggregate is to take the aggregate off
the read path — which is exactly what Phase 11 §7 parked ("materialising current stock …
later, for a measured reason") and Phase 14 Fork B / Phase 19 re-parked. "Phase 22 just
did this for the table next door and pointed here" is the measured reason.

**A shared read fragment has a life-cycle, and deleting it one phase later is that
life-cycle, not churn.** Phase 19's section argued at length for extracting
`joinCurrentStock` rather than copying the SUM a third time (`DashboardService` wanted
the *identical* query `findAll` ran). Phase 23 removes the need for the SUM in reads at
all, so the helper's three callers move to the column and the helper goes. The Phase 19
reasoning was right for Phase 19; a helper that exists to write one query once is
correctly deleted when no read needs that query. `hasHistory` — which rode the same
grouped join in `findAll` — becomes a correlated `EXISTS`, cheaper than the `SUM … GROUP
BY` it replaces, so `findAll` stays a single query.

**The write path gains its first recompute-from-history maintenance step — the deliberate
opposite of the Phases 21/22 background sweeps.** Those are best-effort, probabilistic,
un-`await`ed, and tolerate being skipped. This one is synchronous, transactional, under
the lock, and exact: BR-042 ("current stock always replays from history") holds *by
construction* because the only writer of the column replays history to write it. Drift
is not unlikely — it is unrepresentable short of a bug in one `UPDATE`, and the next
write for that product heals it anyway. So there is no reconcile sweep (nothing to
reconcile); a single integration test (`current-stock.integration.spec.ts`) pins the
invariant, the analogue of the concurrent-stock-out test that pins BR-041. The raw
`UPDATE` is targeted and does **not** bump `products.updated_at` — that column keeps its
"someone edited this product's attributes" meaning; a stock movement is history on
`inventory_transactions`.

**One migration, additive.** `ADD COLUMN current_stock integer NOT NULL DEFAULT 0` plus
a one-shot backfill (`SUM(quantity_delta)` per product) — the fifth migration since
Phase 12, after Phase 18's and Phase 21's. The Phase 19 section's "a `SUM` in a query is
not a stored column; BR-040/042's 'current stock replays from history, never cached' is
reaffirmed, not bent" is left as written — true at Phase 19 — and superseded here: it is
a stored column now, and BR-043 is the invariant that keeps 042 true anyway. **One new
BR** (BR-043) with BR-042 amended — "current stock is now materialised, and here is what
guarantees it still replays from history" is a statement about the business's
relationship to its own numbers, the same reason BR-090 was a rule and the throttle
store was not. **No new FR** (the thirteenth such note): reading a number that means
what BR-040 always said is still FR-023/FR-024.

## Cross-cutting: the catalogue orderings were measured and left unindexed (Phase 24)

Phase 24 (`docs/phase-24-plan.md`, issue #14) discharges a conditional that Phases 11,
14, and 23 each carried in their §7: *the `products.name` / `suppliers.name` / `users`
orderings are unindexed — `EXPLAIN` the paged query and add an index only if a realistic
row count shows one is needed.* It is the first phase in this series (since Phase 6) that
ships **only a decision** — no code, no migration, no schema change.

**`users` was never the unindexed-sort case.** `GET /users` orders by `id ASC`, and `id`
is the primary key; Postgres backs every primary key with a unique B-tree, so that read
has been an ordered index scan since `InitSchema`. Recorded so the `users` half of the
issue stops being re-raised.

**`products.name` / `suppliers.name`: measured, not added.** `EXPLAIN (ANALYZE, BUFFERS)`
of the Phase 14 paged query over `TEMP` tables mirroring the real schema, at 200 / 1,000
/ 10,000 / 100,000 rows, with and without a `name` index (full numbers in
`phase-24-plan.md` §1). At the product's design scale ("dozens", `product.md` §7 — 1,000
rows is already past it) the paged read is sub-millisecond and the index is measurement
noise. `MAX_PAGE_SIZE = 100` pins the first-page sort to a 29 kB `top-N heapsort` at
every scale, so the sort is not what grows; the `EXISTS` subplan and the seq scan are,
and a `name` index removes neither. `getCount()` (the envelope's `total`) is a
`Seq Scan` + `Aggregate` over the filtered set at every scale, unhelped by an ordering
index. Filtered pages (`status` / `categoryId` / `low` / `out`) cannot be satisfied by a
`name` B-tree. And a `name` index makes the deep-`OFFSET` page *measurably worse* (100k
rows: 266 ms → 1795 ms — it walks the index doing ~100k random heap fetches to reach the
offset). The index earns its keep only at ~100,000 catalogue rows, only on the unfiltered
first page — the one path already fast enough.

**So the §7 conditional is discharged with evidence rather than carried forward.** This
is the outcome the "what evidence to look for" section and Phase 11 §7 predicted:
"adding indexes because they might help" is the speculation to refuse, and the honest
artifact is the measurement, so the next catalogue phase crosses the bar with a number
instead of re-deriving the question. The item moves from "deferred, trigger unfired" to
**measured 2026-09-08, declined** — reopen `issue #14` on a real deployment's row counts
and a slow-request log, not on a hunch. **No new FR** (the fourteenth such note); **no
new BR** (how a read is indexed is an implementation fact, the same reason the Phase 21
throttle-store change filed one); no migration, the first "current phase" marker in this
series with no `migration:run`.
