# Phase 23 Plan — Materialise `products.current_stock` as a stored column

Status: Phase 23 — Implemented
Last updated: 2026-09-08
Scope decided with the project owner: **stop computing a product's current stock as a
`SUM(quantity_delta)` over the whole of `inventory_transactions` on every catalogue and
dashboard read, and store it instead as a `products.current_stock` column that every
stock write rewrites from history under the row lock the write already holds** — and
nothing else. This is issue #13, and it is the follow-on Phase 11 §7 named by hand
("caching, materialising current stock, or a read model … *later, for a measured
reason*") and Phase 14 Fork B / Phase 19 each re-parked.

Scoped the same way every phase in this series has been: one headline change, an
explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

Current stock has been derived, never stored, since Phase 2 — and four phases said so
in writing:

| Phase | What it said about a stored `current_stock` |
|---|---|
| 11 §7 | "Caching, materialising current stock, or a read model — `architecture-observations.md` has said since Phase 2 that current stock is derived and may be materialised *later, for a measured reason*; a result cap is not that reason." |
| 14 §7 | "Materialising `current_stock` as a column on `products` (Phase 11 §7, still parked) — Fork B computes it in the read, it does not store it. A stored column needs a write-path invariant (BR-042) that a read-side `SUM` gets for free." |
| 19 | "It **reaffirms** BR-040/BR-042 rather than touching them: current stock is still `SUM(quantity_delta)` computed on demand, never a stored or cached column — this phase only moves the `SUM` from a second round-trip into the products query." |
| `domain-model.md` §4 | "It may be *materialized* for performance later, but conceptually it is not a first-class domain entity." |

**The trigger, stated in the register this project uses.** Phase 22 (`audit_events`
retention) acted on a principle `architecture-observations.md` had already sharpened
past its original wording:

> *a read whose result size — or cost — is a function of how long the business has been
> running is unbounded, and which mechanism does the growing is irrelevant to that.*
> `inventory_transactions` qualifies under the stronger form and always did.

Phase 22 closed that shape for `audit_events` by **pruning the table** to a rolling
year. It then said, in its own §7, that the same fix is *not* available here:

> **Pruning `inventory_transactions`** — it is business history, retained forever
> (BR-050/BR-051). This phase bounds `audit_events` and only `audit_events`; the
> divergence is the point.

So `inventory_transactions` is the table that grows forever and *cannot* be trimmed,
and the two most-hit read paths in the app — `GET /products` and the dashboard
summary — both run a `SUM(quantity_delta) … GROUP BY product_id` over the **entire**
table on every request (Phase 14 Fork B's subquery has no per-product filter; it
aggregates the whole table, then joins). Every stock movement anyone records anywhere,
forever, makes the Product List and the dashboard a little slower to open. That is the
last instance of the Phase 22 shape, and the only fix for it is the one Phase 11 §7
parked: **do not compute it on read.**

**Honesty about the trigger, in the register Phases 11, 14, and 22 used.** It has not
literally fired — every environment still runs `npm run seed`'s ~45 transactions,
nobody has reported a slow Product List, and no deployment has years of history. What
has changed is that Phase 22 *established the principle and acted on it for its sibling
table*, and named this table as the one where its mechanism does not reach. Applying
the parked design now costs an afternoon; re-deriving it against a history that has by
then grown costs a phase — the same cost-curve argument Phases 10, 11, and 14 each
invoked. **If the owner reads the trigger as genuinely unfired and wants to wait, the
coherent choice is to shelve `phase-23` and say so** — not re-park it silently, the
avoidance Phase 12 named. This plan is written on the judgement that "Phase 22 just did
this for the table next door, and pointed here" is new information.

**This phase changes domain documents** — unlike the "no new BR" phases (7, 8, 10, 11,
14–17, 19, 20, 21). It **amends BR-042** (current stock's consistency guarantee now has
a concrete mechanism) and **adds BR-043** (the write-path invariant that maintains the
column), the same way Phase 22 amended BR-082 and added BR-090. `product.entity.ts`'s
"note what's deliberately *not* here" comment, `domain-model.md` §4/§6, and
`architecture-observations.md`'s "a `SUM` in a query is not a stored column"
reaffirmation all become false and all change.

---

## 1. Design decisions

### The mechanism: `insertTransaction` rewrites `current_stock` from history, under the existing lock

`InventoryService` already funnels **all four** write paths through one private method:

- `recordStockIn` → `insertTransaction`
- `recordStockOut` → `insertTransaction`
- `recordAdjustment` → `applyApprovedAdjustment` → `insertTransaction`
- `AdjustmentsService.resolve` (approval) → `applyApprovedAdjustment` → `insertTransaction`

and every one of those already holds a `pessimistic_write` lock on the **product row**
for the duration of the check-and-write (`docs/learning-notes/database-transactions.md`
— this is the mechanism behind BR-041). `insertTransaction` runs inside that lock, in
the caller's `EntityManager`/transaction.

Phase 23 adds one statement to `insertTransaction`, immediately after the transaction
row is saved:

```sql
UPDATE products
   SET current_stock = COALESCE(
         (SELECT SUM(quantity_delta)
            FROM inventory_transactions
           WHERE product_id = $1), 0)
 WHERE id = $1
```

**The column is never patched incrementally — it is always recomputed from the
product's full history.** That is what makes BR-042 ("current stock must always be
reproducible by replaying the product's full transaction history") hold *by
construction*: the only code that writes the column replays history to do it, under the
lock that serialises writers for that product. There is no path that adds a delta, no
path that trusts a prior value. Drift is not "unlikely"; it is unrepresentable, short
of a bug in that one `UPDATE`.

`insertTransaction` is the right host for the same reason it is already the shared
choke point for the insert, the delta, and the zero-delta check: *two code paths that
must produce identical rows should not be two pieces of code* (Phase 12's words). All
four writers get the column maintenance for free, with no change to their bodies.

### Fork A — where the replay-from-history invariant lives. **Decided: app-level, in the shared write path.**

- **A1 — app-level in `insertTransaction` (this design). Chosen by the owner.** The
  invariant lives in the same service, the same method, and the same lock that already
  own every stock write. It reuses the pessimistic-lock machinery
  `database-transactions.md` documents as "the single most important piece of business
  logic" — nothing new to reason about concurrency-wise. **The cost, stated plainly:**
  a future write path that inserts an `inventory_transactions` row *without* going
  through `insertTransaction` would not maintain the column. There is no such path
  today (the `@Check`-style discipline of routing every write through the service is
  already load-bearing for attribution and the lock), and the reconciliation test (§5)
  would catch one being added.
- **A2 — a Postgres `AFTER INSERT` trigger on `inventory_transactions`.** DB-enforced
  regardless of code path, which is a real advantage. Not taken: this codebase has
  **no triggers, functions, or stored procedures** anywhere, by consistent choice
  (Phase 21 refused `pg_cron`, Phase 22 refused a scheduler, `architecture-observations.md`
  argues against infrastructure the local `tools/` Postgres and CI `postgres:17`
  container would have to be taught). A trigger is also invisible at the call site — a
  reader of `insertTransaction` would have no signal the column moves — and would need
  its own migration, its own down-migration, and its own test that the trigger fires.
  The app-level version is a five-line method change reviewed where the write happens.
- **A3 — stored as a cache, `SUM` still authoritative, with a reconcile/repair path.**
  The weakest invariant: reads could still fall back to the `SUM`, drift would be
  tolerated and swept. Not taken: it keeps the full-table `SUM` in the codebase as the
  source of truth, so the read paths cannot safely stop running it — which is the
  entire point of the phase. A1's recompute-on-every-write makes a reconcile sweep
  redundant (nothing drifts), so A3's machinery would be dead weight.

Recorded either way per this series' convention; the owner chose A1.

### Fork B — how the write path sets the column: recompute from history, or apply the delta. **Recommended: recompute from history.**

- **B1 — `SET current_stock = (SELECT SUM(quantity_delta) … WHERE product_id = $1)`.
  Recommended.** Every write rewrites the column from that product's whole history.
  BR-042 is mechanical, not aspirational; the column self-heals on the next write even
  if a bug ever left it wrong. Cost: one indexed aggregate
  (`IDX_2520d97de0c9a0fbfc9b00f4c1` on `inventory_transactions.product_id`) per write.
  `recordStockOut` and the adjustment paths **already run that exact `SUM` under the
  lock** for their BR-021 / delta check, so for three of the four writers this is not a
  new query shape, only a second use of it. `recordStockIn` currently runs no `SUM`;
  it gains one.
- **B2 — `SET current_stock = current_stock + :delta`.** No aggregate at all — the
  cheapest possible write. Not recommended: it makes BR-042 a claim the code no longer
  demonstrates. A single off-by-one in any writer, a manual `INSERT` during an incident,
  a botched data fix — and the column is silently wrong with nothing to bring it back.
  B1's aggregate is cheap where it matters (one product, indexed) and buys the
  guarantee outright.

### Fork C — the read paths switch to the column; `joinCurrentStock` is deleted. **Recommended: yes.**

The point of storing the column is to stop computing it on read, so:

| Caller | Today | After Phase 23 |
|---|---|---|
| `ProductsService.findAll` | `joinCurrentStock` grouped subquery; `status=low`/`out` are `WHERE` over `CURRENT_STOCK_EXPR` | reads `product.current_stock`; `status=low`/`out` are `WHERE` over `product.current_stock` directly |
| `ProductsService.findOne` | `inventoryService.getCurrentStock(id)` (a `SUM`) | reads `product.current_stock` off the entity it already loaded |
| `DashboardService.getSummary` | `joinCurrentStock` grouped subquery + index-align `raw[i]` | reads `product.current_stock`; the `getRawAndEntities` plumbing collapses to a plain `getMany()` |
| `AdjustmentsService` (pending list + preview delta) | `getCurrentStock` / `getCurrentStockMap` | reads `product.current_stock` — so a pending request's "current stock" preview matches the Product List exactly |

- **`backend/src/inventory/stock-aggregate.query.ts` is deleted.** All three of its
  callers move to the column; `STOCK_AGG_ALIAS` / `CURRENT_STOCK_EXPR` / `joinCurrentStock`
  have no remaining use. (Phase 19 extracted this helper specifically so the SUM was
  written once; Phase 23 removes the need for the SUM in reads at all.)
- **`hasHistory` in `findAll` needs a new source.** It currently rides the same grouped
  join (`stock_agg.product_id IS NOT NULL`). Replaced with a correlated
  `addSelect('EXISTS (SELECT 1 FROM inventory_transactions itx WHERE itx.product_id =
  product.id)', 'hasHistory')` — cheaper than the `SUM … GROUP BY` it replaces
  (`EXISTS` short-circuits on the first matching row, same `product_id` index), and
  `findAll` stays a single query. `findOne` keeps `inventoryService.hasHistory(id)` (an
  unchanged `COUNT`), and `getSummary` never needed `hasHistory`.
- **`InventoryService.getCurrentStock` / `getCurrentStockMap` are kept** but repointed
  at the column (they become thin reads of `products.current_stock`). They stay because
  `getCurrentStock` is a small, well-named public API and removing it would churn call
  sites for no gain; their *implementation* stops being a `SUM`.
- **`getCurrentStockLocked` (the private `SUM` under the lock) stays**, and — **as
  built** — the BR-021 / delta checks in `recordStockOut` and `applyApprovedAdjustment`
  keep calling it, unchanged. Those two paths already ran that `SUM` under the lock, so
  keeping the safety check on the replayed value rather than the stored one costs
  nothing and is strictly safer (a bug in the stored column can never let an oversell
  through). Only `insertTransaction` is new code: it calls a new private
  `rewriteCurrentStock(manager, productId)` that runs the Fork B `UPDATE`. `recordStockIn`
  gains its first `SUM` indirectly, via that `UPDATE`.

### Fork D — migration: `NOT NULL DEFAULT 0`, backfilled. **Recommended as stated.**

```sql
ALTER TABLE products ADD COLUMN current_stock integer NOT NULL DEFAULT 0;
UPDATE products
   SET current_stock = COALESCE(
         (SELECT SUM(quantity_delta) FROM inventory_transactions
           WHERE inventory_transactions.product_id = products.id), 0);
```

- **`NOT NULL`** — "unknown stock" is not a valid state; BR-040 says current stock is
  always a defined number, and for a product with zero transactions it is `0`, not
  null (the same COALESCE decision `CURRENT_STOCK_EXPR` already encodes for the read).
- **`DEFAULT 0`** — a newly created product genuinely is at zero, so `ProductsService.create`
  needs no change; the default is correct, not a placeholder. Kept after backfill (not
  dropped) for that reason.
- **The backfill is the same expression as the seed's and the runtime's** — one
  `SUM(quantity_delta)` per product — so a fresh `migration:run` against the seeded dev
  database produces exactly the numbers the mockup and every existing test expect.
- **`down`** drops the column. No enum, no constraint, no index to unwind.

### Fork E — a `CHECK (current_stock >= 0)`? **Recommended: no, but noted.**

BR-041 ("current stock can never be negative") is enforced today only in application
code (the lock + the BR-021 check). A `CHECK` would be a DB-level backstop, and the
column finally makes one *possible* (you cannot `CHECK` a `SUM` over another table).
Not taken here because it is a **BR-041 hardening with its own rationale**, not part of
materialising the column — and bundling it would mean the phase both introduces the
column *and* changes what happens when a write would drive stock negative (does the
`UPDATE` throw a constraint error mid-transaction instead of the app's friendly 409?).
Kept as a clean, self-contained follow-on (§7). Called out because a reviewer will ask.

### Fork F — drift detection at runtime? **Recommended: an integration test only.**

BR-042 demands the column always replays from history. Fork B makes that structural —
the only writer recomputes from history — so a runtime reconcile sweep (à la Phase
21/22) would guard against nothing but a bug in one `UPDATE`. That is what a test is
for. §5's reconciliation integration test runs a battery of mixed writes and asserts
`current_stock == SUM(quantity_delta)` for every product afterward; it is the analogue
of the concurrent-stock-out test that pins BR-041. A periodic sweep is §7.

### Fork G — `run-seed.ts` sets the column too

The seed inserts transaction rows directly via `txRepo.save`, **bypassing
`InventoryService`**, so nothing would maintain `current_stock` for seeded data. After
saving the transaction rows, the seed runs the **same** `UPDATE products SET
current_stock = COALESCE((SELECT SUM …), 0)` — one statement, in the existing seed
transaction, identical to the migration backfill. `npm run seed` continues to produce
the mockup's numbers, now in the column as well as the history.

### No new entity — the three registries are untouched

`current_stock` is a new **column on `Product`**, not a new entity, so
`database.module.ts`, `data-source.ts`, and `test-data-source.ts` are all unchanged
(only `product.entity.ts` gains the `@Column`). Called out because every table-touching
phase since Phase 6 has had a line about these three.

### No new FR; BR-042 amended and BR-043 added

`requirements.md` is functional requirements. Reading a product's current stock is
**FR-023/FR-024**, unchanged — the number means what it always meant (BR-040). What
changes is a **rule about the business's relationship to that number**: BR-042's
consistency guarantee now names a mechanism, and BR-043 states the write-path
invariant. Same reasoning that made Phase 22 add BR-090 rather than file a "no new BR"
note.

---

## 2. What's new (backend)

### Dependency

**None.** No trigger, no function, no scheduler. `insertTransaction` already has an
`EntityManager`; the maintenance is one more `manager.query(...)` on it.

### Migration — `<next timestamp>-AddProductsCurrentStock.ts`

`up`: `ADD COLUMN current_stock integer NOT NULL DEFAULT 0`, then the backfill `UPDATE`
(Fork D). `down`: `DROP COLUMN current_stock`. The one migration this phase ships —
**`npm run migration:run` is required** to pick it up, the first such since Phase 21.

### `products/product.entity.ts`

| Change | What it is |
|---|---|
| `@Column({ name: 'current_stock', type: 'int', default: 0 })` `currentStock: number;` | The stored column. |
| The "note what's deliberately *not* here: a `currentStock` column" comment | **Rewritten** — it now explains that the column *is* here as of Phase 23, that it is a materialisation of `SUM(quantity_delta)`, and that `InventoryService.insertTransaction` rewrites it from history under the product row lock on every write (BR-042/BR-043). |

### `inventory/inventory.service.ts`

| Change | What it is |
|---|---|
| `insertTransaction` → `async`; new private `rewriteCurrentStock(manager, productId)` | After `repo.save(record)`, `rewriteCurrentStock` runs the recompute `UPDATE` (Fork B) on the same `manager`; then the saved row is returned. This is the whole feature. The `UPDATE` is raw `manager.query`, not `repository.update`, so `products.updated_at` is **not** bumped (deliberate — see §1). |
| `getCurrentStock` / `getCurrentStockMap` | Reimplemented as reads of `products.current_stock` via the `Product` repository (Fork C). Signatures and return types unchanged. |
| `getCurrentStockLocked` | Kept, **unchanged**, as the private replay-from-history helper the BR-021 / delta checks still use. |
| BR-021 / delta checks in `recordStockOut` / `applyApprovedAdjustment` | **Unchanged** — still on `getCurrentStockLocked` (the `SUM` under the lock). Those paths already ran it; keeping the check on the replay is free and strictly safer than trusting the column. |
| The `getCurrentStock` doc comment ("never a stored column") + the Writes-section comment block | Rewritten. |

### `inventory/stock-aggregate.query.ts`

**Deleted.** Its three callers move to the column (Fork C).

### `products/products.service.ts`

| Change | What it is |
|---|---|
| `findAll` | Drop `joinCurrentStock`; select `product.current_stock`; `status=low`/`out` become `WHERE product.current_stock <= …`; `hasHistory` becomes a correlated `EXISTS` `addSelect`. Paging, search, status, category filters all unchanged. |
| `findOne` | Read `product.currentStock` off the loaded entity instead of `inventoryService.getCurrentStock(id)`. |
| `mergeStock` / `attachStock` | `currentStock` now comes straight off the entity; `lowStock` / `outOfStock` derivation unchanged. |
| imports | Drop the `stock-aggregate.query` import. |

### `dashboard/dashboard.service.ts`

`getSummary`'s product read becomes `productsRepository.find({ order: { name: 'ASC' } })`
(or the QB equivalent) reading `current_stock` directly; the `joinCurrentStock` +
`getRawAndEntities` + `raw[i]` index-alignment all collapse. `lowStockProducts` /
`outOfStockProducts` / `needsAttention` logic and the response shape are byte-for-byte
unchanged.

### `adjustments/adjustments.service.ts`

The `getCurrentStock(productId)` call and the `getCurrentStockMap([...])` batch both
resolve against the column (they call the same `InventoryService` methods, whose bodies
changed in Fork C — so this file may need **no edit at all**, only its behaviour
follows). Confirm the pending-list preview still reads correctly.

### `database/seeds/run-seed.ts`

After `txRepo.save(rows)`, one `manager.query('UPDATE products SET current_stock = …')`
inside the existing seed transaction (Fork G).

---

## 3. Frontend changes

**None.** Stated because a reader will check. The Product List and Detail screens
already consume `currentStock` as a numeric field on the product response; that field
is still there, still a number, still the same value — it is now read from a column
instead of summed in the query. No `frontend/` file changes, and the `node --test`
suite is not touched.

---

## 4. Documentation updates

1. **`business-rules.md`** —
   - **BR-042 amended.** Today: "Current stock must always be reproducible by replaying
     the product's full transaction history — the two can never diverge." Add: as of
     Phase 23 current stock **is** stored, as `products.current_stock`; the guarantee
     is kept mechanically — `InventoryService.insertTransaction` recomputes the column
     from the product's full `inventory_transactions` history on every stock write,
     inside the pessimistic product-row lock, so the stored value and a fresh replay
     are equal at every commit. The column is never incrementally patched.
   - **BR-043 added** (next free number in the Current Stock section): *the write-path
     invariant.* Every code path that records a stock movement does so through the one
     locked write that also rewrites `current_stock` from history; no path adds a delta
     to the stored value or trusts it without a recompute. Cross-references BR-040,
     BR-042, and BR-041's lock (`database-transactions.md`), and Phase 11 §7 / Phase 22
     as the origin and the trigger.
   - The "no new BR" running list is **not** extended — this phase adds one and amends
     one.

2. **`domain-model.md`** —
   - §4 ("Current Stock as its own entity — No, modeled as a derived value"): the "It
     may be *materialized* for performance later" clause becomes "It **is** materialised
     as of Phase 23 (`products.current_stock`), still not a first-class entity — a
     stored projection of the transaction history, kept equal to it by the write-path
     invariant BR-043."
   - §5 ("Current stock … is derived by aggregating …") and §6 ("A Product's current
     stock (however computed or materialized) is always the sum of its Inventory
     Transactions"): reworded to say the sum is now stored and maintained from history
     on every write, not recomputed on read — the invariant is unchanged, its
     enforcement point moved.
   - §8 (Audit Timestamps): a Phase 23 note on the `products` bullet — the
     `current_stock` rewrite is a raw, targeted `UPDATE` that **does not** bump
     `products.updated_at`, deliberately: `updated_at` means "someone edited this
     product's own attributes", and a stock movement is history on
     `inventory_transactions` with its own timestamps. Letting every stock-in bump the
     product's `updated_at` would blur that meaning.

3. **`architecture-observations.md`** — a Phase 23 cross-cutting section. It records:
   the Phase 22 "cost is a function of how long the business has run" shape is now
   closed for its last instance — `inventory_transactions` could not be pruned
   (business history), so the fix was to stop aggregating it on read; the
   `joinCurrentStock` helper (Phase 19's careful single-copy extraction) is **deleted**
   one phase later, which is the expected life-cycle of a shared read fragment once the
   read stops needing it, not churn; and the write path gains its first
   recompute-from-history maintenance step, a deliberate cousin of the best-effort
   background sweeps (Phases 21/22) but its **opposite** in every safety property —
   synchronous, transactional, under the lock, exact. The line at ~770 ("a `SUM` in a
   query is not a stored column; BR-040/042's 'current stock replays from history,
   never cached' is reaffirmed, not bent") is **left as written** — a dated record of
   what was true at Phase 19 — and the Phase 23 section is where "now stored, and here
   is the invariant that keeps 042 true" is recorded, the convention Phases 21 and 22
   followed.

4. **`requirements.md`** — an "Current Stock materialisation (Phase 23 — no new FR)"
   note beside the Phase 20/21/22 ones: FR-023/FR-024 read exactly as before; the new
   and amended rules are in `business-rules.md` (BR-042, BR-043).

5. **`api.md`** — title bumped to Phase 23. One sentence in the Products section: a
   product's `currentStock` is now served from a stored column maintained from
   transaction history, not summed per request — **no response-shape change, no route
   change, no query-parameter change**.

6. **`README.md`** — Current phase to Phase 23; Phase 22 moves to "Earlier phases".
   Note: current stock is now a stored `products.current_stock` column, backfilled by
   migration and rewritten from history on every stock write under the existing row
   lock (BR-042/BR-043); the Product List and dashboard reads no longer `SUM` the whole
   transaction table. **Run `npm run migration:run`.**

7. **`docs/learning-notes/database-transactions.md`** — a Phase 23 addition: the same
   lock that prevents oversell (BR-041) now also carries the `current_stock`
   maintenance, so materialising a derived value did **not** need a new concurrency
   story — it reused the one already proven by the concurrent-stock-out test. The
   contrast worth teaching: a value can be safely denormalised when there is already a
   serialisation point covering every writer; without the product-row lock, this column
   would have needed one.

8. **`docs/learning-notes/database-access.md`** — a short note: derived-column
   materialisation as the counterpart to Phase 22's read-cap / prune — when the table
   under an aggregate cannot be bounded (business history), move the aggregate off the
   read path instead, and keep the stored copy honest by recomputing it from source on
   every write rather than patching it.

9. **`product.md` §11** — a Phase 23 cross-reference entry in the "no scope change"
   shape (no new user goal, no new use case; issue #13 / Phase 11 §7 named; Q-7 still
   open).

---

## 5. Testing plan

Three things are easy to get silently wrong — the backfill arithmetic, the write-path
recompute, and a read path disagreeing with a fresh replay — and each gets a pinning
test. The split follows the project's convention: SQL semantics and the lock at the
integration layer, wiring at the unit layer. **As built** (190 unit/integration +
108 e2e, all green):

- **Integration — `inventory/current-stock.integration.spec.ts`** (new, real Postgres
  via `createTestDataSource()`, `InventoryService` + `AdjustmentsService` wired the same
  way `adjustments.service.integration.spec.ts` does):
  - **Reconciliation / BR-042/BR-043.** Three products; a mixed battery through
    `InventoryService` (two stock-ins, a stock-out, an immediate Owner adjustment) plus
    an approved Staff-requested adjustment via `adjustments.submit` + `adjustments.resolve`;
    then assert, for **every** product, `current_stock === SUM(quantity_delta)` read
    fresh — and the exact expected totals (30 / 10 / 20). The analogue of the
    concurrent-stock-out test for BR-041.
  - **Recompute, not increment.** Corrupt one row (`UPDATE products SET current_stock =
    999`), record one more stock-in through the service, assert the column is back to
    the true `SUM` (13, not `999 + 3`).
  - **Concurrency.** Two concurrent 8-unit stock-outs against stock 13: exactly one
    fulfilled, one rejected, and `current_stock === SUM === 5` afterward — the `UPDATE`
    runs under the same lock, so the second writer's recompute sees the first's row.
  - **Backfill.** Insert a product with three raw transactions (`+30 / -11 / +4`) and an
    empty product, wipe the column (`SET current_stock = -1`), run the whole-table
    backfill statement, assert `23` and `0`.
  - **No history → 0.** A product with no transactions has `current_stock = 0` and
    `getCurrentStock` returns `0`.
- **Integration — `products.service.integration.spec.ts`** (extended): every existing
  assertion passes **unedited** against the column-based query — the proof Fork C
  changed how the answer is computed, not what it is. The `makeProduct` fixture helper
  gained one line: after inserting the fixture transactions directly (it bypasses the
  locking write path, like `run-seed.ts`), it recomputes `current_stock` with the same
  SQL. One new test pins the `<=` boundary — stock exactly on the threshold is low, one
  above is not.
- **Integration — `dashboard.service.integration.spec.ts`** (extended): same one-line
  fixture-helper change; the summary response stays byte-for-byte identical after
  `getSummary` drops `joinCurrentStock` (the Phase 11 §5 rule — an unrelated diff here
  would be a real regression).
- **Unit — `dashboard.service.spec.ts`**: rewritten to fake `repo.find` instead of the
  query builder / `getRawAndEntities` that Fork C removed; asserts `getSummary` reads
  products in exactly one name-ordered `find` and fires no per-product aggregate.
  `products.service.spec.ts` needed no change. There is no `inventory.service.spec.ts`
  unit spec — the write path has always been covered at the integration layer (it needs
  a real lock and a real `SUM`), and the new integration spec above is where the
  `insertTransaction` recompute is pinned.
- **E2E — no new file.** All seven e2e specs pass **unedited**: they seed through the
  app and read `currentStock` from the API, whose shape is unchanged.
  `adjustments.e2e-spec.ts` (records movements, then reads stock back) exercises the
  write-path maintenance end to end over HTTP. **`smart_inventory_e2e` needs
  `migration:run`** before the suite (recorded in `tools/create-test-databases.mjs` and
  README).
- **Existing suites — pass unchanged** except the mechanical fixture edits above. Full
  backend suite green.

---

## 6. Rollout order

Each step leaves the suite green.

1. **Migration + `product.entity.ts` column + backfill, nothing reads or writes it
   yet.** `migration:run` adds and backfills the column; the entity exposes it; no
   service touches it. App behaviour entirely unchanged. De-risks the schema and the
   backfill arithmetic alone (the backfill integration test lands here).
2. **`insertTransaction` recompute + `run-seed.ts` update + the write-path and
   reconciliation integration tests.** The column is now maintained on every write and
   by the seed, but **still nothing reads it** — `findAll`, `findOne`, `getSummary`,
   `adjustments` are all still on the `SUM`. The stored column and the live `SUM` are
   provably equal (reconciliation test). Full suite green.
3. **Switch the reads: `findAll`, `findOne`, `getSummary`, `getCurrentStock*`,
   `adjustments` → the column; delete `stock-aggregate.query.ts`; `hasHistory` →
   `EXISTS`.** The performance win lands. Read responses byte-for-byte unchanged
   (the extended integration specs prove it). Full suite green.
4. **Documentation (§4)** — BR-042 amendment + BR-043, the `domain-model.md` edits,
   the `architecture-observations.md` section, the no-FR note, `api.md`, `README.md`,
   the two learning-note additions, `product.md` §11. Not optional: the amended
   consistency rule is the deliverable that outlasts the code.

**If cut short, the coherent stopping point is after step 2** — the column exists, is
correct, and is proven equal to the `SUM`; the reads simply have not been repointed
yet, so there is no performance change but also no risk. Steps 1–2 are individually
shippable and observably no-ops.

---

## 7. Explicitly out of scope for Phase 23 (Future)

- **A `CHECK (current_stock >= 0)` constraint** (Fork E) — a DB-level backstop for
  BR-041, now *possible* for the first time because the value is a column. A
  self-contained hardening: it needs its own decision about what a constraint violation
  mid-transaction does to the app's 409, and it is not part of materialising the column.
- **A Postgres trigger for the maintenance** (Fork A2) — revisit only if a write path
  that bypasses `InventoryService` ever becomes necessary; until then the app-level
  version is reviewed where the write happens and keeps this codebase trigger-free.
- **A periodic / opportunistic reconciliation sweep** (Fork F) — Phase 21/22's
  probabilistic-prune pattern applied to "recompute any drifted `current_stock`". Fork
  B makes drift unrepresentable, so this would guard only against a bug in one
  `UPDATE`; the reconciliation integration test covers that. Build it only if the
  column is ever mutated by something other than `insertTransaction`.
- **Incremental (`+= delta`) maintenance** (Fork B2) — the micro-optimisation that
  trades BR-042's mechanical guarantee for one skipped aggregate on a per-product
  indexed lookup. Not worth it at any scale this product reaches.
- **Materialising `hasHistory`, `lowStock`, or `outOfStock` as columns** — `hasHistory`
  is now a cheap `EXISTS`; `lowStock` / `outOfStock` are pure functions of
  `current_stock` and the threshold, derived in one line. None is on the cost curve
  this phase addresses.
- **Denormalising anything onto `inventory_transactions`** (a running balance per row,
  say) — a different feature (audit-style "stock after this movement" display) with its
  own design; not needed to make the catalogue reads fast.
- **Removing `InventoryService.getCurrentStock` / `getCurrentStockMap`** — kept as
  public API; only their bodies change. A later cleanup could inline the map callers,
  but that is churn without a driver.
- **Touching the transaction / audit / adjustment-request **reads**** — they keep
  Phase 11/12's "recent N + `X-Result-Truncated`" shape; this phase is about the
  product/dashboard reads only.
- **An index on `products.current_stock`** — `status=low`/`out` filter it, but over a
  few-hundred-row `products` table a scan is fine (the same bar Phase 11 §7 and Phase
  14 §7 set for `products.name`). `EXPLAIN` the filtered query; add an index only if a
  realistic row count shows it needs one.
- **The `GET /categories` reference-cache read** — the last of
  `architecture-observations.md`'s three named unenforced preconditions still open.
  Untouched here; this phase closes a Phase 11 §7 deferral, not a precondition.
- **Q-4 follow-ons and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] `products.current_stock` exists (`integer NOT NULL DEFAULT 0`), added and
      backfilled by one migration; `npm run migration:run` applies it and the seeded
      dev database shows the mockup's numbers in the column.
- [x] `InventoryService.insertTransaction` rewrites `current_stock` from the product's
      full `inventory_transactions` history (`SET current_stock = COALESCE((SELECT
      SUM(quantity_delta) …), 0)`) on **every** stock write, inside the caller's
      transaction and the existing `pessimistic_write` product-row lock — no
      incremental patching, no trigger, no new dependency.
- [x] An integration test proves, after a mixed battery of writes (including an approved
      adjustment) and after a deliberately corrupted row, that `current_stock` equals a
      fresh `SUM(quantity_delta)` for every product — and that two concurrent
      stock-outs leave it equal to the `SUM` (BR-042/BR-043).
- [x] `ProductsService.findAll`, `ProductsService.findOne`, `DashboardService.getSummary`,
      and `AdjustmentsService`'s stock reads no longer `SUM` `inventory_transactions`;
      `status=low`/`out` filter on `product.current_stock`; `hasHistory` is a correlated
      `EXISTS`. `backend/src/inventory/stock-aggregate.query.ts` is deleted.
- [x] The existing `products.service.integration.spec.ts` and
      `dashboard.service.integration.spec.ts` assertions pass **unedited** — the read
      answer is unchanged, only its source.
- [x] `run-seed.ts` sets `current_stock` from history in the same seed transaction;
      `npm run seed` is idempotent and correct.
- [x] `BR-042` amended (the consistency guarantee now names the stored column and the
      recompute-on-write mechanism); **`BR-043`** added (the write-path invariant);
      `product.entity.ts`'s "deliberately not here" comment, `domain-model.md` §4/§5/§6,
      and `architecture-observations.md`'s "a `SUM` in a query is not a stored column"
      reaffirmation all updated.
- [x] `requirements.md` (no new FR), `api.md` (Phase 23, the one implementation
      sentence, no contract change), `README.md` (Phase 23 + `migration:run`),
      `database-transactions.md` and `database-access.md` learning notes, and
      `product.md` §11 all reflect this phase.
- [x] `frontend/` is untouched; the three DB registries are untouched (no new entity).
- [x] Full backend suite green: unit, the new `current-stock.integration.spec.ts`, the
      extended product/dashboard integration specs, and all seven e2e specs.
