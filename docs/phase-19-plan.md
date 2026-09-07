# Phase 19 Plan — Dashboard stock counts in one query

Status: Phase 19 — Planned
Last updated: 2026-09-07
Scope decided with the project owner: **`DashboardService.getSummary` computes
`lowStockCount` / `outOfStockCount` / `needsAttention` from the same SQL that reads the
products, reusing Phase 14 Fork B's stock-in-SQL join — dropping the second
`inventoryService.getCurrentStockMap()` round-trip** — and nothing else. This is issue
#9, the follow-on Phase 14 §7 named by hand:

> **`DashboardService`'s whole-catalogue `productsRepository.find()`** — the same
> fetch-everything shape, but a summary that reports `lowStockCount` inherently needs
> every product, so it is not a paging problem. Reusing Fork B's stock-in-SQL query to
> drop the dashboard's second round-trip is a legitimate follow-on and explicitly not
> ridden along here.

Scoped the same way every phase in this series has been: one headline change, an
explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

`getSummary` is the one read behind the screen every session opens on. It makes two
trips to the database to answer "how many products are low / out, and which five need
attention":

1. `productsRepository.find()` — every product row.
2. `inventoryService.getCurrentStockMap(products.map(p => p.id))` — a second query, a
   `GROUP BY` over `inventory_transactions` filtered to `product_id IN (…every id…)`,
   materialised into a `Map` and then read back in three `.filter()` passes.

Phase 14 Fork B already did this exact merge — a product's `SUM(quantity_delta)` as a
column on the products query — for `ProductsService.findAll`, and Phase 11 §7 predicted
the trigger would force "moving the low/out filter into SQL" there. The dashboard is
the same computation, one method over, still done the slow way because Phase 14 drew
its scope line at paging and said so.

**Honesty about the trigger, in the register this project uses:** nobody has reported a
slow dashboard, and `npm run seed`'s handful of rows makes both queries trivial. What
makes now the time is not a hunch:

- **The design already exists and is proven.** Fork B's join is in the tree, `EXPLAIN`-
  checked (Phase 14 §6, `database-access.md`), covered by
  `products.service.integration.spec.ts`. Applying it here is a query rewrite against a
  worked example, not a research problem — the same cost-curve argument Phases 11 and 14
  both made.
- **`architecture-observations.md` (Phase 17 section) explicitly parks this as issue
  #9**, distinct from the unbounded-read precondition. Leaving a named, tracked,
  one-afternoon follow-on unstarted with no new information is the re-deferral this
  project's own standard rejects.
- **It removes a whole round-trip from the hottest read in the app** for the cost of a
  shared helper the codebase was going to want anyway (three call sites of one join —
  §1 Fork A).

**This phase changes no domain document.** No FR (a summary computed in one query
instead of two is not a user goal — §4), no BR (BR-040/042 "current stock is
`SUM(quantity_delta)`, never stored" is *reaffirmed*, not changed), no entity, no
route, no migration. The dashboard summary response is **byte-for-byte identical** —
same keys, same types, same values — proven by the e2e suite passing unedited.

---

## 1. Design decisions

### Fork A — reuse Fork B's join by copying the pattern, or by extracting it. Recommended: extract it

Fork B's grouped-subquery join lives inline in `ProductsService.findAll`. Phase 17
needed the *same shape* for a different aggregate (`COUNT(*)` over `products`) and
**copied the pattern** into `CategoriesService.findAll` — a deliberate call, recorded
in `architecture-observations.md` ("reused Phase 14 Fork B's pattern exactly").

Phase 19 is different: `DashboardService.getSummary` wants the **identical** query
`findAll` runs — same table, same `SUM(quantity_delta)`, same `COALESCE`, same
`product_id` join. A literal third copy of one SQL fragment is the case the codebase's
own rule points at ("two code paths that must produce identical rows should not be two
pieces of code" — `inventory.service.ts`). So:

- **A1 — extract `joinCurrentStock(qb, productAlias?)` into
  `backend/src/inventory/stock-aggregate.query.ts`.** It adds the `leftJoin` subquery
  and the `currentStock` `addSelect`, returns the builder (chainable). Two exported
  constants — `STOCK_AGG_ALIAS` and `CURRENT_STOCK_EXPR` — let callers build their own
  expressions over the aggregate without restating the join alias.
  `ProductsService.findAll` is rewritten to call it (its `hasHistory` select and its
  `status=low` / `status=out` `WHERE` conditions stay — they layer on top).
  `DashboardService.getSummary` calls it too. **Recommended.**
- **A2 — copy the join inline into `DashboardService`, matching the Phase 17
  precedent.** Rejected: Phase 17 copied an *analogous* query (different table,
  different aggregate); this would be a *verbatim* copy, and the third instance is
  where the copy stops paying for itself. Extracting now also tidies `findAll`, at the
  cost of touching "the most load-bearing query in the app" — done deliberately, behind
  the integration spec that already guards it.

`inventory_transactions.product_id` is indexed (`IDX_2520d97de0c9a0fbfc9b00f4c1`,
`InitSchema`), so the `GROUP BY` has support. **No migration** — a computed column in a
read is not a schema change (the note Phases 14 and 17 both made).

### Fork B — keep the JS count/filter logic, or push it into `WHERE`. Recommended: keep it

`findAll` turned `status=low` / `status=out` into `WHERE` conditions because it *pages*
— it must not fetch 50 rows and then filter. The dashboard does not page: it needs
**every** product anyway (active/inactive counts, and `outOfStockCount` spans the whole
catalogue). Counting a list it already holds in memory is not a cost worth a query
rewrite, and the `if (p.lowStockThreshold === null) return false` branch (BR-061) stays
where a fast unit test can reach it.

- **B1 — the query returns products + `currentStock`; `getSummary` keeps its three
  `.filter()` passes and the `needsAttention` slice, reading `p.currentStock` instead
  of `stockMap.get(p.id)`.** The BR-062 decision (out-of-stock-with-no-threshold counts
  toward `outOfStockCount` but is excluded from `needsAttention`) is untouched — same
  code, same `dashboard.service.spec.ts` guard. **Recommended.**
- **B2 — compute the counts as SQL aggregates** (`COUNT(*) FILTER (WHERE …)`).
  Rejected: it trades a readable three-line filter for a bespoke aggregate query,
  needs the product rows fetched separately anyway for `needsAttention`, and buys
  nothing at catalogue scale.

### Fork C — `needsAttention` ordering. Recommended: `ORDER BY name ASC`, and note it

The old `find()` had **no `ORDER BY`**. When more than five products are low-stock,
which five land in `needsAttention` was whatever order the executor produced for an
unordered scan — not guaranteed, and not stable across runs. The shared helper's
natural companion `ORDER BY product.name ASC` (what `findAll` uses) makes it
deterministic.

- **C1 — order by `name ASC`.** A behaviour change only in the tie-break sense: on a
  catalogue with ≤5 low-stock products (every seeded and realistic small deployment)
  the set is identical; past that, `needsAttention` becomes "the first five low-stock
  products alphabetically" instead of "five arbitrary ones". This is the same
  determinism *improvement*, stated not glossed, that Phase 11 made for
  `recentActivity`'s `id` tie-break. **Recommended**, recorded in
  `architecture-observations.md` and the method comment.
- **C2 — leave it unordered.** Rejected: keeps a latent "why did the dashboard list
  change when nothing changed" bug for no benefit.

---

## 2. What's new

No new dependency, no new module, no new route, **no migration**. One new helper file,
two services touched, one unit spec rewritten, one integration spec added.

| File | Change |
|---|---|
| `backend/src/inventory/stock-aggregate.query.ts` | **new** — `joinCurrentStock(qb, productAlias?)` plus `STOCK_AGG_ALIAS` / `CURRENT_STOCK_EXPR`. The Fork B join, extracted verbatim. |
| `backend/src/products/products.service.ts` | `findAll` calls `joinCurrentStock` instead of restating the `leftJoin` + `COALESCE(...)` select; `hasHistory` and the low/out `WHERE` clauses reference the exported constants. Generated SQL unchanged — proven by `products.service.integration.spec.ts` passing unedited. |
| `backend/src/dashboard/dashboard.service.ts` | `getSummary` replaces `productsRepository.find()` + `inventoryService.getCurrentStockMap()` with one `joinCurrentStock(createQueryBuilder('product')).orderBy('product.name','ASC').getRawAndEntities()`; attaches `currentStock` per row; the count filters and `needsAttention` slice are otherwise untouched. |

`inventoryService.getCurrentStockMap` **stays** — `AdjustmentsService` still calls it
(`adjustments.service.ts`). Only the dashboard's call goes.

`run-seed.ts`, `configuration.ts`, `.env.example`, the DTOs, the controller — no
change. The `GET /dashboard/summary` response shape and values are identical.

---

## 3. Frontend changes

**None.** `frontend/views/dashboard.js` consumes the same JSON. Not touched, not
tested here (the frontend `node --test` suite is unaffected).

---

## 4. Documentation updates

1. **`requirements.md`** — a ninth "no new FR" note, beside Phases 7, 8, 10, 11, 14,
   15, 16, 17. "Compute a summary in one query instead of two" is an implementation
   detail of a read; FR-050 (the dashboard) and FR-004/FR-060/FR-061 (products, low
   stock) read exactly as before.
2. **`business-rules.md`** — a "no new BR" line, the eighth such (after Phases 10, 11,
   15, 14, 16, 17 — Phase 18 added one). It carries the one thing worth stating:
   BR-040/042's "current stock is `SUM(quantity_delta)`, computed on demand, never a
   stored column" is **reaffirmed** — this phase moves the `SUM` into a different query,
   it does not cache or store it.
3. **`architecture-observations.md`** — a Phase 19 cross-cutting section: the Fork B
   join is now a shared helper (`joinCurrentStock`), three call sites
   (`ProductsService.findAll`, `CategoriesService.findAll`'s sibling pattern, and now
   `DashboardService`); the dashboard is down from two catalogue round-trips to one;
   the `needsAttention` ordering became deterministic (Fork C); still no migration; the
   "issue #9" pointer in the Phase 17 section is marked done.
4. **`docs/learning-notes/database-access.md`** — a short addition to the existing
   "computed column via a subquery join" block: the join is now
   `joinCurrentStock(qb)`, and `DashboardService` shows the pattern used **without**
   paging — `getRawAndEntities()` straight, no `getCount` / `offset` / `limit`, because
   the caller genuinely wants every row.
5. **`README.md`** — Current phase to Phase 19. One line in the operational register:
   the dashboard summary is unchanged in every observable way; **no migration** (unlike
   Phase 18).
6. **`api.md`** — title to Phase 19. `GET /dashboard/summary`'s row is unchanged; add
   nothing to it. The existing "No route's shape, status code, or field list changes"
   line already covers this phase.
7. **`product.md` §11** — a one-line Phase 19 entry in the register every phase gets,
   in the Phase 7/10/11/14–17 "no scope change" shape: §4/§5/§7 unchanged, no
   `domain-model.md` change, the `DashboardService` follow-on Phase 14 §7 named.
8. **`domain-model.md`** — **no change**, stated here because a reader will check:
   nothing about an entity, a relationship, an invariant, or a column.

---

## 5. Testing plan

- **Unit — `dashboard.service.spec.ts` (rewritten).** The repository fake becomes a
  query-builder fake (the pattern `audit.service.spec.ts` already uses):
  `createQueryBuilder → { leftJoin, addSelect, orderBy, getRawAndEntities }`. The three
  existing cases are kept, re-expressed against `getRawAndEntities`'s
  `{ entities, raw }`:
  - BR-062: an out-of-stock product with `lowStockThreshold === null` counts toward
    `outOfStockCount` but is absent from `needsAttention`.
  - The Phase 11 regression guard — `listAll({ limit: 8 })` + `countSince(7)`, not a
    whole-table read — extended with `createQueryBuilder` called **once** (this phase's
    own guard: one products query, no second stock round-trip).
  - An out-of-stock product *with* a threshold appears in both, and `needsAttention[0]`
    carries `currentStock: 0`.
- **Integration — `dashboard.service.integration.spec.ts` (new, real Postgres, the
  same harness `products.service.integration.spec.ts` uses).** A mock cannot prove the
  SQL sums the deltas:
  - A mixed fixture (active/inactive, low/out/normal, a no-history product, one product
    with multiple transactions): the four counts are right, `low` spans active +
    inactive exactly as before, a no-history product reads `currentStock` 0 and counts
    as out.
  - `needsAttention` carries each row's real summed `currentStock`, name-ordered.
  - `needsAttention` caps at 5, and with seven low-stock products named out of
    insertion order it returns the first five *by name* (the Fork C determinism).
- **E2E — unchanged and unedited.** `roles.e2e-spec.ts` already asserts
  `GET /dashboard/summary` returns 200 for Staff and Owner. The whole e2e suite passing
  with no edit **is** the "response shape and values did not change" proof (Phase 11
  §5's rule: a diff here would be a real regression).
- **`EXPLAIN`** the dashboard query against the dev database — it is Fork B's plan with
  no `WHERE` and an `ORDER BY name`, already known-sane, but confirmed once.

---

## 6. Rollout order

Leaves-first, bootable at every step.

1. **`stock-aggregate.query.ts` + `ProductsService.findAll` rewired to it.** Pure
   refactor — generated SQL identical. `products.service.integration.spec.ts` and the
   products e2e green prove it. Individually shippable.
2. **`DashboardService.getSummary` rewritten** to one `joinCurrentStock` read. Unit
   spec rewritten, integration spec added, full backend suite + e2e green.
3. **Documentation** (§4).

**If cut short, stop after step 1** — a behaviour-preserving extraction that leaves the
dashboard exactly as it was. Stopping mid-step-2 is the bad place: `getSummary` half
converted.

---

## 7. Explicitly out of scope for Phase 19 (Future)

- **Materialising `products.current_stock` as a stored column** (Phase 11 §7, Phase 14
  §7 — still parked). This phase computes the `SUM` in one query instead of two; it
  does not store it. A stored column needs the BR-042 write-path invariant a read-side
  `SUM` gets for free.
- **Making `getSummary` a single round-trip.** It is now two (the products+stock query,
  then `listAll({ limit: 8 })` + `countSince(7)` — actually three DB calls). Collapsing
  the recent-activity and 7-day-count reads into the first is possible but they are
  cheap bounded reads over a different table (Phase 11 already fixed the expensive part)
  and merging them buys little for real complexity. Not now.
- **A dashboard integration/e2e assertion on `transactionsLast7Days` or
  `recentActivity`** — untouched by this phase, still covered where Phase 11 left them.
- **Touching `CategoriesService.findAll`'s copy of the pattern** to route through
  `joinCurrentStock`. It joins a different table for a different aggregate; folding it
  in would be a forced fit. Left as the deliberate copy Phase 17 made it.
- **Any change to `getCurrentStockMap`** — it keeps its `AdjustmentsService` caller and
  its shape.
- **Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [ ] `DashboardService.getSummary` makes **one** query for products and their current
      stock (via the shared `joinCurrentStock`), not `productsRepository.find()` plus
      `inventoryService.getCurrentStockMap()`. Asserted by the unit guard
      (`createQueryBuilder` called once) and the integration spec.
- [ ] `GET /dashboard/summary` returns the **same keys, types, and values** as before —
      proven by the e2e suite passing unedited.
- [ ] The Fork B join is a shared helper; `ProductsService.findAll` calls it and its
      generated SQL is unchanged (`products.service.integration.spec.ts` passes
      unedited).
- [ ] `needsAttention` is deterministic — `ORDER BY name ASC` — with the tie-break
      behaviour change (first five low-stock by name past a count of five) recorded in
      `architecture-observations.md` and the method comment.
- [ ] BR-062's unit coverage survives the rewrite: an out-of-stock product with no
      threshold counts toward `outOfStockCount` and stays out of `needsAttention`.
- [ ] **No migration**, no domain-document change (`requirements.md` gets a ninth
      no-FR note, `business-rules.md` a no-BR line reaffirming BR-040/042, nothing
      else). `README.md` and `api.md` say so.
- [ ] Full backend suite green — unit, integration (including the new dashboard cases),
      all e2e — and `EXPLAIN` on the dashboard query shows a sane plan.
- [ ] Every fork decided and recorded: extract vs. copy the join (A), JS filters vs.
      SQL `WHERE` (B), `needsAttention` ordering (C).
