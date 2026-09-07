# Phase 14 Plan — Catalogue Paging

Status: Phase 14 — Planned
Last updated: 2026-09-04
Scope decided with the project owner: **give the four catalogue list screens
(`/products`, `/suppliers`, `/categories`, `/users`) a real paging design — a page,
a page size, a total, and Prev/Next on the screen — fixing the last unbounded reads
in the API, and add the frontend's first automated test to cover the paging logic
it introduces** — and nothing else. Scoped the same way `phase-3-plan.md` was scoped
to authentication, `phase-11-plan.md` to bounded transaction reads, `phase-12-plan.md`
to adjustment approval, and `phase-13-plan.md` to the frontend module split: one
headline change, an explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

Phase 11 bounded the two transaction-log reads and **deliberately left the four
catalogue reads uncapped**, with a concrete trigger and a design brief for the day it
fired (`docs/phase-11-plan.md` §7):

> when the Product List screen is slow enough for someone to mention it, or when a
> real deployment passes a few hundred products, the answer is a paging design for
> that screen — a total, a next page, and moving the low/out filter into SQL — not a
> ceiling bolted onto the existing route.

| Phase | What it said about the catalogue reads |
|---|---|
| 11 | introduced the split (log = reading position, catalogue = wrong answer); deferred the four with the trigger and brief above (§7, Fork A) |
| 12 | "still parked, still with its trigger unfired… the reason is unchanged" (§7) |
| 13 | didn't mention them — but made them *buildable*: the frontend stopped being one 3,061-line file, so a paging control now lands in `views/products.js` as a contained change instead of an edit to a file holding sixteen other screens |

**Honesty about the trigger, in the register Phase 11 §"why now" used for the empty
transaction table:** it has not literally fired. Every environment this project runs
in still uses `npm run seed`'s handful of rows, nobody has reported a slow Product
List, and no deployment has hundreds of products. What has changed is threefold, and
none of it is a hunch:

- **Phase 13 removed the structural reason it kept being deferred.** Before Phase 13
  a paging control meant editing `index.html` alongside every other screen; after it,
  `views/products.js` is 347 lines about products and nothing else. The frontend is
  ready for its first feature-bearing change in a way it was not.
- **Phase 11 already wrote the design.** "A total, a next page, moving the low/out
  filter into SQL" is a brief, not a research problem. Applying it costs an afternoon;
  re-deriving it against a catalogue that has by then grown costs a phase — the same
  cost curve Phase 11 §"why now" and Phase 10 §"why this phase" both invoked.
- **`architecture-observations.md` holds three unenforced preconditions "of one
  shape"** (the in-memory throttle store, the best-effort audit write, the four
  unbounded catalogue reads) and frames closing them as the goal, on Phase 10's
  precedent that "an entry that only ever grows is not evidence of anything." This
  phase retires the tractable part of one of them.

**If the owner reads the trigger as genuinely unfired and wants to wait, the coherent
choice is to wait — and say so in `phase-14` being shelved, not re-park it silently.**
Re-deferring with no new information is the avoidance Phase 12 §"why this phase" named.
This plan is written on the judgement that the three points above are new information.

**This phase changes no domain document.** No new FR (paging is transport plus a
small screen affordance — §4), no new BR (a paging window is a property of a read, not
a rule about the business — §4), no new entity, no route added or removed. The only
documents that change are `api.md`, `architecture-observations.md`, `README.md`, and
one learning note — plus the "no new FR/BR" notes in `requirements.md` and
`business-rules.md` that Phases 10, 11, and 12 each left.

---

## 1. Design decisions

### The sharpest line: three of the four "catalogue reads" have a second consumer that needs the whole set

This is the fact the tidy version of this phase does not survive, and it has to come
first because every fork below accommodates it. "Bound the catalogue reads" sounds
like four routes each getting a `LIMIT`. The repository says otherwise:

| Route | List screen (wants a page) | Second consumer (wants **every** row) |
|---|---|---|
| `GET /products` | `views/products.js` `productList` | the stock/adjustment **wizard's product picker** (`views/transactions.js:331`), and the **category screen's** "which products use this category" read (`views/categories.js:25`) |
| `GET /suppliers` | `views/suppliers.js` `supplierList` | the stock-in wizard's **supplier picker** (`views/transactions.js:44`, `status:'active'`) |
| `GET /categories` | `views/categories.js` `categoryList` | `Store.loadReferenceData()` — the global `CATEGORIES` cache every product form's dropdown reads (`api.js:134`) |
| `GET /users` | `views/users.js` `userList` | *(none — single consumer)* |

A picker that is silently capped at 50 is a **correctness cliff**, not a slow screen:
a user cannot record a stock movement against product #51. So "make the route return a
page" breaks three of the four callers unless the pickers are redesigned into
typeahead/search-as-you-type controls that query a paged, searchable route — which is a
real UX change to two wizards and a screen, with its own justification. That is a
**separate phase**, and pretending otherwise here would be the punch-list-riding-along
every plan in this series has refused.

**What this phase does instead:** the four routes gain **optional** `page` / `pageSize`
parameters. Supplied, the response is a paged envelope. Omitted, the response is the
bare array exactly as today — so the pickers and the reference cache are byte-for-byte
untouched. The list screens pass the parameters; nothing else does.

**What this honestly buys, stated rather than glossed (the `users.locked_until`
discipline Phase 10 and 11 both applied):** the four catalogue reads are still
unbounded *by default*, because three of them must be. What changes is that the
**screens** that render them are bounded, the routes *can* be bounded by any caller
that wants a page, and `GET /users` — the one with no second consumer — could be made
non-optionally paged if a reviewer prefers (Fork D). The unbounded-read precondition
in `architecture-observations.md` is **partly** retired, with the picker-typeahead
redesign named as the trigger for the rest (§7). This is the same shape as Phase 11
bounding what it could honestly bound and deferring the rest with a concrete trigger.

### Fork A — offset/limit, or cursor/keyset. Recommended: offset/limit with a total

Phase 11 §7 refused `?offset=` for the log reads, and the reason was specific: *"a
table where new rows arrive at the top"* ships the classic skipped-row bug the moment
an offset page is turned while a row is inserted above it.

**A catalogue is the opposite table.** It is ordered `name ASC` (stable, not
insertion order), rows are added one at a time by a person choosing to add one
(`product.md` §3's "1–10 people"), and the sort key does not move. The skipped/
duplicated-row window on an offset page still exists in principle, but it requires
someone to add a product named "Mango" while another user is looking at page 3, sorted
by name — a race measured in the seconds a human takes to click Next, on a table that
grows a few times a week. That is a tolerable window where the log feed's was not.

Offset also buys what a catalogue UI actually wants and keyset cannot give cheaply: a
**total** ("Page 3 of 12 · 573 products") and **random access** (jump to the last
page). Keyset pagination is the right tool for an infinite feed; it is machinery this
phase does not need.

- **A1 — `?page=N&pageSize=M`, `SELECT … LIMIT M OFFSET (N-1)*M`, plus a `COUNT(*)`
  over the same filtered set.** The count is a full scan of a catalogue table — a few
  hundred rows at this project's scale, and the exact scan Phase 11 §1 refused for the
  logs *because there the filtered set was the whole transaction history*. Here it is
  not. **Recommended.**
- **A2 — cursor/keyset (`?after=<name>,<id>`).** Rejected: no cheap total, no
  random-access page, and it solves a churn problem the catalogue does not have.

TypeORM's query builder does offset + count in one call — `getManyAndCount()` — which
is what §2 uses.

### Fork B — `ProductsService.findAll`'s post-SQL low/out filter. Recommended: compute current stock in the query, unconditionally

`ProductsService.findAll` runs its SQL, then filters `status=low` / `status=out` **in
application code** (`products.service.ts:82-84`), because both compare current stock —
a `SUM(quantity_delta)` from `inventory_transactions` — against the per-product
threshold, and the `WHERE` clause cannot see a value that is computed after the query.
Phase 11 §1 named this as the mechanical reason a naive `LIMIT` on this route is not
merely unhelpful but *wrong*: `?status=low&pageSize=50` would take the first 50
products by name and *then* filter, returning however many of those 50 happen to be
low.

- **B1 — move the `SUM` into the read as a subquery join, so `lowStock` / `outOfStock`
  become real `WHERE` conditions.** Sketch (exact form is the implementer's, verified
  by `EXPLAIN`):

  ```sql
  SELECT p.*, COALESCE(s.stock, 0) AS current_stock, (h.pid IS NOT NULL) AS has_history
  FROM products p
  LEFT JOIN (SELECT product_id, SUM(quantity_delta) AS stock
             FROM inventory_transactions GROUP BY product_id) s ON s.product_id = p.id
  LEFT JOIN (SELECT DISTINCT product_id AS pid FROM inventory_transactions) h ON h.pid = p.id
  WHERE <search / status=active|inactive / categoryId as today>
    AND (:low  IS NOT TRUE OR (p.low_stock_threshold IS NOT NULL AND COALESCE(s.stock,0) <= p.low_stock_threshold))
    AND (:out  IS NOT TRUE OR COALESCE(s.stock,0) <= 0)
  ORDER BY p.name ASC
  LIMIT :pageSize OFFSET :offset;
  ```

  Run this way **whether or not paging is active** — the `.filter()` in
  `findAll` is deleted, not conditionalised, so there is one code path. This is a
  strict improvement even for the unpaged callers: it also removes the two extra
  round-trips (`getCurrentStockMap` + `getHasHistoryMap`) that `findAll` fires today.
  **Recommended**, and it is exactly the change Phase 11 §7 predicted this trigger
  would require ("moving the low/out filter into SQL").
- **B2 — keep the post-SQL filter; page in application code** (fetch all matching,
  filter, then `slice`). Rejected: still O(all matching products) in memory and over
  the wire, which is the cost the phase exists to remove.
- **B3 — push `LIMIT` only for the non-computed filters, leave `low`/`out` unpaged.**
  Rejected: `low` is precisely the filter an Owner reaches for when the catalogue is
  large, so the one path that most needs paging would be the one without it.

`inventory_transactions` already carries an index on `product_id`
(`IDX_2520d97de0c9a0fbfc9b00f4c1`, `InitSchema`), so the grouped subquery join has
support. **No migration this phase** — this is a query rewrite, not a schema change.
`architecture-observations.md` records that a reviewer arriving from Phases 11 and 12
(each of which shipped a migration) will look for one and there is none.

`suppliers`, `categories`, and `users` have no computed filter — their `findAll`
methods are plain `repository.find({ order })` — so they take `skip`/`take`/count with
no rewrite.

### Fork C — response shape: an envelope on the catalogue routes, or more headers. Recommended: an envelope, catalogue routes only

Phase 11 chose a **header** (`X-Result-Truncated`, presence-is-the-signal) for the log
reads and wrote down why an envelope lost there (§1, Fork B): the logs did not need a
`total`, and an envelope would break four screens and three e2e specs that destructure
a bare array.

**This phase inverts both halves of that reasoning.** It *does* need a `total` — "Page
3 of 12" is the feature — and computing one is cheap here (Fork A). And the callers
that must not break are the pickers and the reference cache, which this phase leaves on
the **bare-array** path by not sending paging params.

- **C1 — `{ items, page, pageSize, total }` on `/products`, `/suppliers`,
  `/categories`, `/users`, returned only when `page` or `pageSize` is present in the
  query; bare array otherwise.** Four `Store` methods learn a paged variant; the four
  list views read `.items` and `.total`; every other caller is untouched because it
  sends no paging param. **Recommended.**
- **C2 — headers only (`X-Total-Count`, `X-Page`, …), keep bare arrays always.**
  Rejected: a numeric header that is always present with a meaningful value is a
  different contract from Phase 11's presence-signal header, it grows the
  `Access-Control-Expose-Headers` list by three, and "read three headers and do the
  page math" is worse at the call site than one envelope. The frontend already has the
  `_request(..., { withTruncation })` → `{ data, truncated }` pattern; C1 extends that
  shape, it does not invent one.

**The asymmetry is deliberate and worth a sentence in `api.md`:** logs return "recent
N + filters + `X-Result-Truncated`"; catalogues return "page N of a total". That is
Phase 11 §1's "a cap on a log is a reading position; a cap on a catalogue is a wrong
answer" made concrete in two response shapes, not an inconsistency to iron out later.

### Fork D — which routes, and is `/users` special. Recommended: optional paging on all four; leave `/users` optional too

All four list screens get the same treatment, so §8 can say the near-flat thing —
*every list screen in the app is paged* — and the three easy routes
(`suppliers`, `categories`, `users`) share one trivial `skip`/`take`/count pattern.

`GET /users` is the one route with no second consumer (table above), so it *could* be
made **non-optionally** paged — a cleaner "this route cannot return an unbounded
result" statement for at least one of the four. Recommended against, narrowly: it is
Owner-only and tiny in every realistic deployment, the optional form keeps all four
routes identical in shape, and a future `GET /users` caller (there is none today)
would not trip over a mandatory envelope. A reviewer who prefers the stronger
statement for `/users` may take it; it is a one-line change and does not affect any
other fork.

### Fork E — page size: constants, a query param the client controls, or configuration. Recommended: constants, client may lower via `pageSize`, following Phase 11

`InventoryService` holds `const DEFAULT_LIMIT = 100` in the file with `@Max(500)` in
the DTO, and Phase 11 §1 argued that against a `configuration.ts` entry: *"no
deployment tunes a page size."* This phase copies that exactly.

- `DEFAULT_PAGE_SIZE = 50`, `MAX_PAGE_SIZE = 100` as module constants in each service
  (or one shared `common/` constant — implementer's call, it is the same number).
- `pageSize` in the DTO: `@IsOptional() @IsInt() @Min(1) @Max(100)` — validation, not
  clamping, so `pageSize=1000` is the documented `400`, the same call Phase 11 made for
  `limit`.
- `page`: `@IsOptional() @IsInt() @Min(1)`, default 1. A `page` past the last returns
  `{ items: [], page, pageSize, total }` — an empty page is a valid answer to "show me
  page 99", not a `404` (the frontend disables Next before this happens; a hand-typed
  URL gets an empty table, not an error).
- No `.env.example` line, no `configuration.ts` entry.

### Fork F — the frontend paging control. Recommended: one shared `UI.pager()` — Prev · "Page X of Y · N items" · Next

Phase 11 §3 explicitly deferred "a page-size control, a 'load more' button, infinite
scroll, or a page-number strip", noting that adding one to the History screen alone
"would make it the only paged screen in an app where the Product List is not." This
phase is where that resolves — by paging the Product List, not by leaving History the
odd one out.

- **F1 — Prev / position text / Next, below the table, rendered by one
  `UI.pager({ page, pageSize, total })` helper** (the sibling of `UI.truncationNotice`
  — one helper, every list screen calls it). Prev disabled on page 1, Next disabled on
  the last page, hidden entirely when `total <= pageSize`. Any search or filter change
  resets `page` to 1 (a filtered result has its own page 1). **Recommended.**
- **F2 — a numbered page strip (1 2 3 … 12).** Saves clicks on a large list; more code
  and more edge cases (ellipsis logic) for catalogues that will rarely exceed a few
  pages. Not now.
- **F3 — "load more" / infinite scroll.** Hides the total and the end, and re-querying
  on a filter change while a scroll position is held is fiddly. Rejected.

The History / Audit / Approvals screens keep Phase 11/12's truncation notice — they
are not becoming paged, they are a different interaction model (Fork C). This phase
does not touch them.

### Fork G — add the frontend's first automated test now, or defer once more. Recommended: add it, minimally

Phase 13 §7 named this exact phase:

> **Trigger:** the first phase that adds genuinely new frontend *logic* rather than
> relocating existing logic — that phase should add the harness to cover its own new
> behaviour, not retroactively for [Phase 13].

Paging is that logic: `page` state, reset-to-1-on-filter-change, disable-Prev-on-first,
disable-Next-on-last, and the "Page X of Y" arithmetic (`Math.ceil(total / pageSize)`,
off-by-one-prone). Deferring the harness again would be the re-deferral-with-no-new-
information pattern this project's own standard rejects — and the trigger is not vague,
it points here.

- **G1 — add a minimal harness: `frontend/package.json` (the first one) with one
  devDependency (`jsdom` or `happy-dom`), `npm test` runs `node --test`.** Keep the
  surface small by extracting the arithmetic as a pure function —
  `pagerModel(page, pageSize, total) → { totalPages, hasPrev, hasNext, label, skip }`
  — so most coverage is plain unit tests with no DOM at all, and only the
  reset-on-filter behaviour needs jsdom. **Recommended.**
- **G2 — defer again, cover paging by the backend suite + the manual smoke walk only.**
  The honest case for it: this adds `frontend/node_modules`, which the project has
  resisted since `serve.js` was written, and Phase 13 rejected a *bundler* on those
  grounds. The honest case against it: Phase 13 §7 already had this argument and drew
  the line here; a harness is not a bundler (no build step, no config, runs on `node`
  alone), and "the first real frontend logic ships untested" is the outcome the
  trigger exists to prevent.

This is a real second decision in the phase, smaller than the headline and
pre-authorised by Phase 13 §7. It is called out as a fork because it adds the
frontend's first dependency and the owner should get to veto that specifically.

---

## 2. What's new (backend)

No new dependency, no new module, no new route, **no migration**. Four DTOs extended,
four service `findAll` methods changed (one rewritten — Fork B), four controllers
return an envelope when asked.

### The DTOs

`QueryProductsDto`, `QuerySuppliersDto`, `QueryUsersDto` (new — `/users` binds no query
object today), and a query DTO for `/categories` (also new — `CategoriesController.findAll`
takes nothing today) each gain:

```ts
// Phase 14 (docs/phase-14-plan.md §1 Fork E). Optional: absent means "the whole list",
// the shape every non-screen caller (the wizard pickers, the CATEGORIES cache) still
// relies on. Floor and ceiling are validation, not clamping — pageSize=1000 is a 400,
// the same call Phase 11 made for `limit`. Default page size lives in the service.
@IsOptional() @Type(() => Number) @IsInt() @Min(1)
page?: number;

@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
pageSize?: number;
```

### The services

| Service | Change |
|---|---|
| `ProductsService.findAll` | **rewritten (Fork B)** — current stock and `hasHistory` computed in the query via subquery joins; `low`/`out` become `WHERE` conditions; the post-SQL `.filter()` and the two `getCurrentStockMap`/`getHasHistoryMap` round-trips are deleted. When `page`/`pageSize` are set, add `skip`/`take` and return `getManyAndCount`'s `[rows, total]`; otherwise return the full list as today. |
| `SuppliersService.findAll` | add `skip`/`take` + count when paging params are present; `repository.findAndCount` instead of `find`. No rewrite. |
| `CategoriesService.findAll` | same; gains a query-DTO parameter it does not have today. |
| `UsersService.findAll` | same. |

Each `findAll` returns `Product[] | { items, page, pageSize, total }` (and the three
siblings likewise) — a union the controller narrows. The alternative (always return the
envelope, make every caller destructure) is rejected for the reason Fork C rejects the
envelope-always shape: it breaks the pickers.

### The controllers

Each list route: if `query.page` or `query.pageSize` is set, return
`{ items, page, pageSize, total }`; else return the array. Four `if`s, no interceptor —
the same call `result-truncated.header.ts`'s comment records for the header (an
interceptor would have to infer paging from a body that may or may not be an envelope).

### `run-seed.ts`, `configuration.ts`, `.env.example`, `DashboardService` — no change

Seeding writes rows; this phase reads them (consistent with Phases 7–13). `DashboardService`
calls `productsRepository.find()` directly, **not** `ProductsService.findAll`, so the
rewrite does not reach it — see §7 for why the dashboard's whole-catalogue read is not
this phase's problem and what the follow-on would be.

---

## 3. Frontend changes

Four list views, four `Store` methods, one new `UI` helper, and (Fork G) the first
`frontend/package.json`.

**1. `Store.listProducts` / `listSuppliers` / `getUsers` / a new `listCategoriesPaged`
gain an optional `{ page, pageSize }`.** With it, they hit `?page=&pageSize=` and return
`{ items, page, pageSize, total }`; without it, unchanged — a bare array, which is what
`views/transactions.js`'s pickers and `views/categories.js:25` keep calling.
`loadReferenceData()` is **untouched** — it still `GET /categories` with no params and
still gets every category for the `CATEGORIES` cache.

**2. `views/products.js` / `suppliers.js` / `categories.js` / `users.js` list functions
hold `page` state**, pass it to the `Store` call, render `UI.pager(...)` below the
table, and **reset `page` to 1 on any search or filter change** (the existing
`load()`-on-change handlers gain one line).

**3. `UI.pager({ page, pageSize, total })`** — new, beside `UI.truncationNotice`:

```
‹ Prev        Page 3 of 12 · 573 products        Next ›
```

Returns `''` when `total <= pageSize`. Prev/Next are `<button>`s wired in each view's
`attach()` (no inline handlers — the Phase 13 invariant, §5). The noun ("products" /
"suppliers" / …) is a parameter, like `truncationNotice`'s.

**4. (Fork G) `frontend/package.json` + `frontend/pager.js`.** `pagerModel(page,
pageSize, total)` — the pure arithmetic — moves into its own tiny module so it is
unit-testable without a DOM; `UI.pager` imports it for the markup. `frontend/test/`
holds `pager.test.js` (pure) and one `products-list.test.js` (jsdom — asserts a filter
change resets to page 1 and re-requests). `npm test` in `frontend/` runs `node --test`.

**Explicitly not in this phase's frontend:** a page-size selector, a numbered strip,
"load more", sortable column headers, or making the pickers searchable. The first four
are Fork F alternatives; the last is §7's named follow-on and the reason the routes'
paging is optional.

---

## 4. Documentation updates

1. **`api.md`** — title to Phase 14. The four catalogue routes gain `?page=&pageSize=`
   in their query column. A new short section beside the `X-Result-Truncated`
   paragraph: **the catalogue reads return `{ items, page, pageSize, total }` when
   `page` or `pageSize` is supplied, and the bare array otherwise** — with one sentence
   on why the shape differs from the log reads (reading position vs. page of a total,
   Phase 11 §1's cut in two shapes). Note `pageSize` max 100, out-of-range is `400`,
   and a `page` past the end is an empty `items` array, not `404`.
2. **`requirements.md`** — a fifth "no new FR" note beside Phases 7, 8, 10, and 11. It
   carries the one interpretation this phase must not leave unstated, the same move
   Phase 11 made for FR-030/031's "all": **FR-004's "view all products with current
   stock and status" describes the screen's subject, not one HTTP response's payload.**
   A paged Product List still lets a user view the list of all products.
3. **`business-rules.md`** — **no new BR**, one line with its reason, the third such
   after Phases 10 and 11. A paging window is a property of a read; BR-060/061 (low
   stock), BR-002 (product status), BR-070–074 (who may read what) all say exactly what
   they said before.
4. **`architecture-observations.md`** — the substantive entry, in that file's currency:
   - The three-preconditions note is updated. The catalogue-reads precondition is
     **partly retired**: every list *screen* is now paged and the routes accept a page,
     but three of the four routes still return the full set to a picker or the
     reference cache that needs it, so the precondition survives on those paths — with
     **the picker-typeahead redesign named as the trigger** that would close it (§7).
     Two-and-a-half preconditions of the original three, not two.
   - **Offset over keyset (Fork A)**, and why the reason Phase 11 §7 gave against
     `?offset=` for the logs (rows arrive at the top) does not hold for a name-ordered
     catalogue a person grows a few times a week.
   - **The envelope/header asymmetry (Fork C)** recorded as deliberate: two response
     shapes because they answer two different questions, not an inconsistency.
   - **Fork B's move of current-stock into the read query** — the change to "the most
     load-bearing query in the app" that Phase 11 §7 predicted this trigger would
     force, done deliberately and `EXPLAIN`-checked, and **no migration**, which a
     reviewer arriving from Phases 11–12 will look for.
   - **The frontend got its first test (Fork G)** — Phase 13 §7's trigger fired here,
     as that plan said it would; what was added and how small it was kept.
5. **`product.md` §11** — a Phase 14 cross-reference in the Phase 7/10/11 register: no
   user goal in §4, no use case in §5, no scope change in §7. Q-4 and Q-7 remain open,
   untouched since Phase 5.
6. **`domain-model.md`** — **no change**, stated in this list because Phases 7, 9, 10,
   and 12 each edited it and a reader will check. Nothing here is about an entity, a
   relationship, an invariant, or a column.
7. **`README.md`** — Current phase to Phase 14. One operational note in the Riley /
   lockout / empty-audit-log register: **the Product List showing 50 rows with
   Prev/Next is the feature, not a truncated query** — the total is on the pager and the
   other pages are one click away. Plus, explicitly, **no migration this phase** (unlike
   Phases 11 and 12), so no `migration:run` reminder is needed.
8. **`docs/learning-notes/database-access.md`** — extended, not a new note (Phase 10/11
   precedent — TypeORM/`pg` mechanics live here). Content: `getManyAndCount` / `findAndCount`
   and the one extra `COUNT(*)` they issue; building a computed column with a subquery
   `leftJoin((qb) => …)` + `addSelect` and reading it back off `getRawAndEntities`; and
   **why `OFFSET` pagination is correct for a stably-ordered catalogue and a
   skipped-row bug for a top-of-feed log** — the same distinction Phase 11 drew, now
   with the other side worked. Optionally a one-paragraph note (or its own short file)
   on the Fork G harness, at the implementer's discretion.

---

## 5. Testing plan

Backend gets real assertions; the frontend gets its first (Fork G) plus the manual
smoke walk Phase 13 established.

- **Integration — `products.service.integration.spec.ts`** (new or folded into an
  existing products spec; real Postgres, which the inventory suite already uses):
  - **The Fork B rewrite preserves the unpaged result.** With a fixture spanning
    active/inactive, low/out/normal stock, and a category filter: `findAll(query)` with
    no paging params returns the **same products in the same order** (`name ASC`) as the
    pre-rewrite method, and each carries the same `currentStock` / `lowStock` /
    `outOfStock` / `hasHistory`. This is the "no behaviour change for existing callers"
    guard, and it must be written against a fixture where `low` and `out` actually
    differ from `active`.
  - **`status=low` + paging returns low-stock products, paged** — not "the first
    `pageSize` alphabetical products, then filtered" (Phase 11 §1's failure mode).
    Fixture: 12 low-stock products among 40; `?status=low&page=1&pageSize=5` returns 5
    low-stock products, `page=3` returns the last 2, `total` is 12 throughout.
  - **`total` is the count of the filtered set, not the table.** `?search=…&page=1&pageSize=10`
    → `total` equals the number of matches, asserted against a separate `COUNT`.
  - **A page past the end is empty, not an error.** `?page=99&pageSize=10` → `200`,
    `items: []`, `total` unchanged.
- **Integration — `suppliers` / `categories` / `users`** (lighter, no rewrite): one
  spec each — paging params slice correctly, `total` is right, omitting them returns the
  full list unchanged.
- **E2E — `app.e2e-spec.ts` and the relevant per-resource specs:**
  - `?pageSize=0`, `?pageSize=101`, `?pageSize=abc`, `?page=0` → `400` in the documented
    validation shape.
  - Envelope present **only** when a paging param is sent; a request with neither param
    gets a bare JSON array (the pickers' contract — assert the type, not just the
    contents).
  - `roles.e2e-spec.ts` / `users.e2e-spec.ts`: `GET /users?page=1&pageSize=2` still
    Owner-only (`403` for Staff) — paging does not change the gate.
- **Existing specs — where a diff is expected vs. a regression** (Phase 11 §5's rule):
  any spec that asserts on a full catalogue array is unaffected *because the default is
  still the full array* — this is the payoff of optional paging. A spec that fails here
  is a real regression, not a fixture-size artefact.
- **Frontend — Fork G, new:**
  - `pager.test.js` (pure, no DOM): `pagerModel(1, 50, 573)` → `{ totalPages: 12,
    hasPrev: false, hasNext: true, skip: 0 }`; `pagerModel(12, 50, 573)` → `hasNext:
    false`; `pagerModel(1, 50, 40)` → `totalPages: 1` (and `UI.pager` renders `''`);
    the `total = 0` and `total exactly divisible by pageSize` boundaries.
  - `products-list.test.js` (jsdom): rendering the list, then dispatching an `input` on
    the search box, re-requests with `page=1` even if the user was on page 3.
- **Manual smoke walk** (Phase 13 §5, the relevant slice): both roles — Product List
  paging forward/back, Prev disabled on page 1, Next disabled on the last page, a filter
  change snapping back to page 1, the pager hidden when one page suffices; the stock
  wizard's product and supplier pickers still list **every** active option (the
  unbounded-picker path); the category screen's product-count read still sees all
  products; a fresh login still populates the category dropdown.

No new unit test for the DTO decorators — `class-validator` behaviour, and the e2e
`400` cases prove the wiring (Phase 10/11's call).

---

## 6. Rollout order

Leaves-first, bootable at every step, in the manner of Phases 11–13.

1. **`ProductsService.findAll` rewritten (Fork B), no paging params yet.** Current
   stock and `hasHistory` move into the query; `low`/`out` become `WHERE`; the
   post-SQL filter and the two round-trips are deleted. Verify with `EXPLAIN` that the
   plan is sane and with the integration spec that the unpaged result is identical to
   before. Individually shippable — it changes how the answer is computed, not the
   answer.
2. **The four DTOs + the four services take `page`/`pageSize`** and return the union.
   Controllers return the envelope when asked. Backend e2e green.
3. **`Store` methods take optional `{ page, pageSize }`.** The pickers and
   `loadReferenceData` are visibly left alone in the diff.
4. **`UI.pager` + `frontend/pager.js`**, then the four list views wired one at a time —
   Products first (it exercises the Fork B path), then Suppliers, Categories, Users.
   Reload and page through each before moving on.
5. **Fork G harness** — `frontend/package.json`, the two test files, `node --test`
   green.
6. **The manual smoke walk** (§5), both roles, with the picker paths checked explicitly.
7. **Documentation** (§4). As in every phase in this series, the docs outlast the code
   and are not optional in any cut.

**If cut short, the coherent stopping point is after step 1** — the Fork B rewrite is a
strict improvement (fewer round-trips, same result) and leaves a shippable app with no
paging. Stopping between steps 2 and 4 is the bad place: the routes accept `page` but no
screen sends it and no pager renders, so the feature is half-wired with nothing to show
for it.

---

## 7. Explicitly out of scope for Phase 14 (Future)

- **Searchable / typeahead pickers** in the two stock wizards and the category screen —
  the real closure of the unbounded-read precondition (§1). The pickers fetch every
  option today and still will after this phase; making them query a paged, searchable
  route is a UX change to three call sites with its own justification. **Trigger:** a
  deployment where a picker's full-set fetch is measurably slow, or a product decision
  to make the pickers searchable. Named first because a reviewer will ask why the
  routes' paging is optional, and this is the answer.
- **Cursor / keyset pagination anywhere** (Fork A). Offset is adequate for a
  name-ordered catalogue a person grows a few times a week; the log reads already
  declined offset in Phase 11 §7 and keep their model.
- **Changing the transaction / audit / adjustment-request reads** — they keep Phase
  11/12's "recent N + filters + `X-Result-Truncated`" shape. This phase's envelope is
  catalogue-only, deliberately (Fork C).
- **An index on `products.name` / `suppliers.name` / the `users` ordering** — still
  unindexed, still not on the evidence bar (Phase 11 §7). `EXPLAIN` the paged query; add
  an index only if a realistic row count shows it needs one.
- **Materialising `current_stock` as a column on `products`** (Phase 11 §7, still
  parked) — Fork B computes it in the read, it does not store it. A stored column needs
  a write-path invariant (BR-042: current stock must always replay from history) that a
  read-side `SUM` gets for free.
- **`DashboardService`'s whole-catalogue `productsRepository.find()`** — the same
  fetch-everything shape, but a summary that reports `lowStockCount` inherently needs
  every product, so it is not a paging problem. Reusing Fork B's stock-in-SQL query to
  drop the dashboard's second round-trip is a legitimate follow-on and explicitly not
  ridden along here.
- **A page-size selector, a numbered page strip, "load more", infinite scroll** (Fork
  F alternatives).
- **Sortable column headers** on the list screens — the catalogue order stays `name
  ASC` (`id ASC` for users). Click-to-sort is a screen feature with its own scope.
- **Deleting the `mockFetch` / `?state=` scaffolding** (Phase 13 §7) — untouched again,
  same trigger.
- **A shared throttle store** (Phase 8 §7) and **an `audit_events` retention policy**
  (Phase 9 §7) — still parked, still recorded in `architecture-observations.md`, still
  not this phase's problem.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [ ] `GET /products`, `/suppliers`, `/categories`, `/users` accept `?page=&pageSize=`;
      with either present they return `{ items, page, pageSize, total }`, with neither
      they return the bare array **exactly as before** — proven by an existing
      full-list spec passing unedited.
- [ ] `pageSize` is validated `1..100` and `page` `>= 1`; an out-of-range value is
      `400`, never a silent clamp. A `page` past the last returns an empty `items`
      array with the real `total`, not `404`.
- [ ] `ProductsService.findAll` computes current stock and `hasHistory` in the query
      (Fork B); the post-SQL `low`/`out` `.filter()` and the `getCurrentStockMap` /
      `getHasHistoryMap` round-trips in `findAll` are gone. `EXPLAIN` shows a sane plan.
      An integration test proves the unpaged result — products, order, and every
      computed field — is identical to the pre-rewrite method on a fixture where
      `low`/`out` genuinely differ from `active`.
- [ ] `?status=low&page=…&pageSize=…` returns low-stock products *paged*, with `total`
      equal to the count of all low-stock matches — not the first `pageSize` alphabetical
      products then filtered. Asserted with a fixture where the two differ.
- [ ] The stock and adjustment wizards' product and supplier pickers, the category
      screen's product read, and the post-login `CATEGORIES` cache all still receive the
      **complete** set — verified in the smoke walk, because these are the callers the
      optional-paging design exists to protect.
- [ ] Every list screen (`products`, `suppliers`, `categories`, `users`) renders
      `UI.pager(...)` below the table: Prev disabled on page 1, Next disabled on the
      last page, the whole control hidden when one page suffices, and `page` reset to 1
      on any search or filter change.
- [ ] **No migration** — this phase is a query rewrite and additive params, and
      `README.md` says so explicitly where Phases 11 and 12 said the opposite.
- [ ] The frontend has its first automated test (Fork G): `pagerModel` covered as a
      pure function including the `total = 0`, single-page, and exactly-divisible
      boundaries, plus one jsdom test that a filter change re-requests at page 1.
      `frontend/package.json` exists with one devDependency; `npm test` in `frontend/`
      runs `node --test` green. (Or Fork G was explicitly declined by the owner and that
      is recorded here.)
- [ ] **No domain document changed:** `product.md` (beyond a §11 cross-ref),
      `requirements.md` (beyond a fifth no-FR note), `business-rules.md` (beyond a
      no-BR line), `domain-model.md` (not at all), and `api.md`'s *route list* gains no
      route. Confirmed by inspection.
- [ ] `api.md` documents the optional envelope and the catalogue/log shape asymmetry
      with its one-sentence reason; `architecture-observations.md` records the
      precondition as *partly* retired with the typeahead trigger, the offset-over-keyset
      call, the envelope/header asymmetry, the Fork B query change with no migration, and
      that Phase 13 §7's frontend-test trigger fired here.
- [ ] Every fork was decided and recorded either way: offset vs. keyset (A), the
      `ProductsService` rewrite (B), envelope vs. headers (C), which routes and whether
      `/users` is special (D), page-size constants vs. config (E), the pager control
      shape (F), and adding the frontend test harness (G).
- [ ] Full backend suite green — unit, integration (including the new products cases),
      and all e2e specs — and the frontend `node --test` suite green.
