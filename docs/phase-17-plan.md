# Phase 17 Plan — Searchable / Typeahead Pickers

Status: Phase 17 — Implemented on branch `1102huynh/issue-7-searchable-typeahead-pickers`
(all steps done and verified locally — backend `nest build` + `lint:check` clean,
`npm test` 16 suites / 165 tests, `npm run test:e2e` 7 suites / 106 tests, frontend
`npm test` 23 tests; a live-API smoke of the four endpoint shapes; a browser walk of
the two pickers is the one check left to the reviewer).
Last updated: 2026-09-07

**[2026-09-07, on implementation]**
- **The count-shape fork (Fork A) resolved to paged-path-only** with the owner: the
  bare-array `GET /categories` that fills the `CATEGORIES` reference cache is
  byte-for-byte unchanged; `productCount` rides only the paged envelope's items.
- **The categories reference cache stays a plain unbounded read (Fork D).** Category
  dropdowns on the product form remain a `<select>` — a genuinely small fixed set. So
  this phase closes the unbounded-catalogue-reads precondition for `/products` and
  `/suppliers` and leaves it standing on that one `/categories` path, by decision.
- **The typeahead is one jsdom-tested module (Fork C).** `frontend/typeahead.js`, not
  a pure-core + wrapper split — the testable surface is behaviour (debounce, the
  stale-response guard, select/clear), not arithmetic, so jsdom covers it directly,
  the way `products-list.test.js` already does.
- **Debounce is 200 ms, picker page size is 20** (Fork E), both plain arguments the
  two call sites pass — tests pass `debounceMs: 0`.

Scope decided with the project owner: **turn the three catalogue reads that still
fetch every row for a non-screen caller into searchable controls — the stock-in
wizard's supplier `<select>`, the Inventory History product-filter `<select>`, and the
Categories screen's client-side product count — so that closing the "unbounded
catalogue reads" precondition (`docs/architecture-observations.md`, `docs/phase-14-plan.md`
§7) is actually done for `/products` and `/suppliers`** — and nothing else. Scoped the
same way `phase-14-plan.md` was scoped to catalogue paging and `phase-16-plan.md` to a
clean lint: one headline change, an explicit out-of-scope list, no punch-list riding
along.

## Why this phase, why now

Phase 14 gave the four catalogue routes an **optional** `?page=&pageSize=` and paged
every list *screen*, but deliberately left three call sites reading the whole
catalogue, because a picker silently capped at 50 is a **correctness cliff** — a user
cannot record a movement against product #51 — not a slow screen. `phase-14-plan.md`
§1 and §7, and `architecture-observations.md`'s Phase 14 section, name this work as the
successor that "fully retires the precondition", and give it a trigger:

> **Trigger:** a deployment where a picker's full-set fetch is measurably slow, or a
> product decision to make the pickers searchable. Named first because a reviewer will
> ask why the routes' paging is optional, and this is the answer.

**Honesty about the trigger, in the register Phases 11 and 14 used:** it has not
literally fired — every environment still runs `npm run seed`'s handful of rows, and
nobody has reported a slow picker. What is new is narrower than a hunch:

- **Phase 14 already built the routes.** `GET /products?search=&page=&pageSize=` and
  `GET /suppliers?search=&status=active&page=&pageSize=` exist, are tested, and return
  the paged envelope today. The searchable picker is a frontend control over an
  endpoint that is already there — this phase adds no query capability the backend
  did not ship in Phase 14.
- **Phase 14 wrote down the design and the trigger points here.** "Make the pickers
  query a paged, searchable route" is a brief, not a research problem. Applying it is
  an afternoon; re-deriving it against a catalogue that has by then grown is a phase —
  the same cost curve Phase 11 §"why now" and Phase 14 §"why now" both invoked.
- **The precondition is the one open item on the Phase 14 ledger.** Everything else
  Phase 14 named as follow-on is a separate issue (#9 dashboard, #13 stored column,
  #14 indexes). This is the piece that lets `architecture-observations.md` stop saying
  "two-and-a-half of three".

**This phase changes no domain document.** No new FR (a typeahead is a screen
affordance over an existing route — §4), no new BR (searching a list is not a rule
about the business — §4), no new entity, no route added or removed. The documents that
change are `api.md`, `architecture-observations.md`, `README.md`, and one learning
note — plus the "no new FR / no new BR" lines that Phases 10, 11, 14, 15, and 16 each
left in `requirements.md` and `business-rules.md`.

---

## 1. Design decisions

### The three call sites, and what each becomes

The census, from the repository rather than memory (grep for `listProducts` /
`listSuppliers` callers in `frontend/`):

| Call site | Before | After |
|---|---|---|
| `views/transactions.js` — stock-in wizard supplier field | `Store.listSuppliers({ status: 'active' })` renders a `<select>` of **every** active supplier | a typeahead querying `GET /suppliers?search=&status=active&pageSize=20` |
| `views/transactions.js` — Inventory History product filter | `Store.listProducts({})` renders a `<select>` of **every** product | a typeahead querying `GET /products?search=&pageSize=20` |
| `views/categories.js` — Categories screen "N products" column | `Store.listProducts()` fetches the whole catalogue, `.filter().length` per row | a server-computed `productCount` on the paged `GET /categories` read |

After this phase, `GET /products` and `GET /suppliers` have **no caller that requests
the whole set**. `GET /categories` still has one — `Store.loadReferenceData`, the
`CATEGORIES` cache every product form's dropdown reads — which is left as-is (Fork D).

### Fork A — where the category count lives. Recommended: on the paged envelope's items only

The Categories screen needs each category's product count. The count is a
`COUNT(*)` over `products` grouped by `category_id` — cheap at this project's scale,
and the exact kind of computed column Phase 14 Fork B already added to
`ProductsService.findAll` (a subquery `leftJoin` + `addSelect`, read back off
`getRawAndEntities`).

- **A1 — attach `productCount` to each item in the paged `{ items, … }` branch only;
  the no-param branch stays a bare `Category[]` with no computed field.** The
  Categories admin screen is the *only* caller that pages `GET /categories`
  (`Store.listCategoriesPaged`), so it is the only caller that sees `productCount`.
  `Store.loadReferenceData` sends no paging param and its response is untouched —
  the byte-for-byte-unchanged shape three product forms rely on. Two branches in
  `findAll`, which it already has. **Recommended, and chosen.**
- **A2 — compute `productCount` on every response, paged or not.** One code path,
  marginally simpler query wiring. Rejected: it puts an unused field on the
  reference-cache response, and Phase 14 went to real lengths to keep that response
  identical — the whole reason its paging is optional. "One code path" is not worth
  reopening a contract the rest of the design protects.
- **A3 — a dedicated `GET /categories/product-counts` endpoint.** Rejected: a new
  route for a number that belongs on the row that is already being fetched.

### Fork B — the picker page size and "there are more". Recommended: fetch 20, and say when there are more

A typeahead that queries a paged route still has to decide what "capped" means. The
cliff Phase 14 named is *silent* capping. So:

- **B1 — request `pageSize=20`; when the envelope's `total` exceeds what is shown,
  render a non-selectable `+N more — keep typing to narrow` line at the foot of the
  menu.** The user is never left thinking the list is complete when it is not — the
  control's own text tells them to type more. `20` is a menu height, not a data
  limit. **Recommended, and chosen.**
- **B2 — request a large page (100) and just scroll.** Rejected: it is the Phase 14
  cliff with a taller wall — 101 suppliers and #101 is still unreachable, now with no
  hint.
- **B3 — require a minimum query length before querying at all.** Rejected as a
  default: with `minChars: 0` the control queries the first page on focus and behaves
  like the `<select>` it replaces for a small shop — a short list you just pick from.
  `minChars` is a knob a call site can raise; neither of these two does.

### Fork C — the typeahead: one module, or a pure core plus a DOM wrapper. Recommended: one jsdom-tested module

`pager.js` (Phase 14 Fork G) split its pure arithmetic into its own module so most of
its test surface needed no DOM. A typeahead's surface is different: a debounce, a
request-sequence guard that drops a stale response, a menu that opens and closes,
keyboard navigation, "revert the text to the committed selection on blur". Almost none
of that is a pure function.

- **C1 — one module, `frontend/typeahead.js`, exporting `createTypeahead(mountEl,
  opts)`; covered by `frontend/test/typeahead.test.js` (jsdom), the harness
  `products-list.test.js` already established.** **Recommended, and chosen.**
- **C2 — a pure `typeaheadModel()` plus a thin DOM shell.** Rejected: the model would
  be a state machine with almost no logic outside the DOM effects, so the split would
  add a seam without moving much behind it.

It is a module, not a `UI.*` helper, for the reason `pager.js` is: two views share it
and a test targets it directly. `UI.pager` / `UI.truncationNotice` are pure
markup-returning functions; this holds live state and listeners.

### Fork D — the categories reference cache. Recommended: leave it a plain unbounded read

`Store.loadReferenceData` does a bare `GET /categories` (no paging param) to fill the
`CATEGORIES` cache that every product form's category `<select>` reads synchronously.

- **D1 — leave it exactly as-is.** Categories are a small, slow-growing, fixed set —
  `npm run seed` makes five; a real small business has maybe a dozen. A `<select>` of
  a dozen options is the right control, and a typeahead over it would be worse UX for
  no gain. The unbounded-read precondition is then **retired for `/products` and
  `/suppliers`** and **explicitly noted as surviving on this one `/categories`
  path** — the same shape as Phase 14 bounding what it honestly could and recording
  the rest. **Recommended, and chosen.**
- **D2 — also make the product-form category picker a typeahead and page
  `GET /categories` everywhere.** Rejected: a larger UX change than the issue names
  (it lists three sites, all in the two transaction views), and it makes a small
  fixed list harder to use to satisfy a bookkeeping goal ("fully retired").

### Fork E — debounce interval and where the knobs live. Recommended: 200 ms / pageSize 20, as call-site arguments

Following Phase 14 Fork E's call against a `configuration.ts` entry for the page size
("no deployment tunes a page size"): `debounceMs` (default `200`) and `pageSize`
(the call site passes `20`) are plain arguments to `createTypeahead`. The frontend
test passes `debounceMs: 0`. No constants file, no `.env` line.

### Fork F — keeping a picked value across a view re-render. Recommended: the view owns `{ id, label }`, the typeahead is re-seeded

Both host views re-render their whole container on a `load()` (the History view on
every filter change; the wizard on a validation failure). The typeahead instance is
destroyed with the DOM each time.

- **F1 — the view keeps the committed selection as `{ id, label }` in its own state
  and passes it back as `initial` when it rebuilds the control; `createTypeahead`
  returns `{ destroy() }` and the view calls it before re-instantiating.** The label
  is what lets the review step and the re-rendered filter show a name without another
  fetch. **Recommended, and chosen.**
- **F2 — a persistent typeahead instance that survives re-renders.** Rejected: it
  fights the "rebuild `innerHTML`, re-attach" model every view in this app uses since
  Phase 13; a re-seeded throwaway instance is consistent with it.

---

## 2. What's new (backend)

No new dependency, no new module, **no new route, no migration.** One service method
gains a branch; one integration spec and one e2e spec gain cases.

### `CategoriesService.findAll` (`backend/src/categories/categories.service.ts`)

The **no-param branch is unchanged** — `this.categoriesRepository.find({ order })`,
a bare `Category[]`. The **paged branch** is rewritten from `findAndCount` to a
query-builder read:

```ts
const total = await this.categoriesRepository.count(); // no filter on categories
const { entities, raw } = await this.categoriesRepository
  .createQueryBuilder('category')
  .leftJoin(
    (sub) => sub
      .select('product.category_id', 'category_id')
      .addSelect('COUNT(*)', 'count')
      .from(Product, 'product')
      .groupBy('product.category_id'),
    'product_agg',
    'product_agg.category_id = category.id',
  )
  .addSelect('COALESCE(product_agg.count, 0)', 'productCount')
  .orderBy('category.name', 'ASC')
  .offset(paging.skip)
  .limit(paging.take)
  .getRawAndEntities<RawCount>();

const items = entities.map((category, i) => ({
  ...category,
  productCount: Number(raw[i]?.productCount ?? 0), // pg returns COUNT(*) as a bigint string
}));
return pageEnvelope(items, total, paging);
```

Return type widens to `Category[] | Paged<CategoryWithCount>` where
`CategoryWithCount extends Category { productCount: number }` — a plain interface, not
a DTO, the same call `ProductWithStock` makes. `categories.service.ts` now imports
`Product` from `../products/product.entity` (entity metadata only — no repository
injection, no `CategoriesModule` change; the entity↔entity import already exists both
ways).

`categories.controller.ts` is untouched — it returns whatever the service hands back.

### `run-seed.ts`, `configuration.ts`, `.env.example`, `DashboardService` — no change

Seeding writes rows; this phase reads them. `DashboardService` still does its own
`productsRepository.find()` — issue #9, deliberately not ridden along.

---

## 3. Frontend changes

One new module, CSS for it, two views rewired, one view simplified.

### `frontend/typeahead.js` (new)

`createTypeahead(mountEl, { emptyLabel, initial, search, onSelect, minChars = 0,
debounceMs = 200 })` → `{ destroy() }`. `search(query)` returns
`Promise<{ items: [{ id, label }], total }>`; `onSelect` gets `{ id, label } | null`.

- Renders a search-icon input, a `×` clear button (shown once something is picked),
  and a `role="listbox"` menu into `mountEl`.
- Debounced query; **race-safe** — a per-search sequence counter drops a response
  whose search has been superseded.
- Menu shows the `items`, plus `+N more — keep typing to narrow` when
  `total > items.length`, plus `No matches` when empty.
- Keyboard: Arrow up/down move the active option, Enter commits it, Escape closes and
  reverts the text.
- Click-outside and blur close the menu; the visible text always snaps back to the
  committed selection, never a half-typed query.
- Every listener is attached by the factory to an element it created — the Phase 13
  "no inline `on*` handler" invariant.
- `destroy()` clears the debounce, invalidates any in-flight search, and removes the
  one `document` listener — called by each host view before it re-instantiates.

`frontend/styles.css`: a `.typeahead*` block beside `.search-input` / `.select-filter`
/ `.pager`, using the existing tokens. `.toolbar .typeahead` picks up the
`flex:1; max-width:320px` the toolbar filters use; in a `.field` it is full width.

### `frontend/views/transactions.js`

**`historyView`** — the `#h-product` `<select>` becomes `<div id="h-product">`; the
view holds `productId` + `selectedProductLabel`; `attachHeaderHandlers()` tears down
and re-creates `productPicker` on every render, seeded from that state. `load()` drops
the `Promise.all([Store.listProducts({}), …])` — it fetches only transactions now.
`onSelect` sets the two state fields and calls `load()`.

**`transactionWizard`** — `activeSuppliers` and the `Store.listSuppliers` call in
`load()` are gone. `form` gains `supplierLabel`. The stock-in supplier `<select>`
becomes `<div id="f-supplier">`; `attach()` (form step) instantiates `supplierPicker`,
seeded from `form.supplierId`/`form.supplierLabel`, and destroys it on any non-form
render. `readForm()` no longer reads a supplier field (the typeahead's `onSelect`
keeps `form` current); `reviewHtml()` shows `form.supplierLabel`; the "Record Another"
reset clears it.

### `frontend/views/categories.js`

`Store.listProducts()` and the `products` array are removed; `load()`'s `Promise.all`
collapses to just `Store.listCategoriesPaged`. `countFor` reads `c.productCount ?? 0`.
The top-of-file comment about the client-side count is rewritten.

### `frontend/api.js`

No new method — `listProducts` / `listSuppliers` already take `{ search, pageSize }`
and return the envelope. Only `listCategoriesPaged`'s doc comment changes (it now
notes `productCount` on items).

**Explicitly not in this phase's frontend:** a typeahead on the product-form category
picker (Fork D), a typeahead anywhere the data is not a catalogue (roles, reason
categories, date ranges — all closed enums), `minChars > 0` on either picker, or
recent/favourite suggestions.

---

## 4. Documentation updates

1. **`api.md`** — title/status to Phase 17. `GET /categories`: the paged envelope's
   items now carry `productCount` (a server-side count); the bare array is unchanged.
   One line on `GET /products` / `GET /suppliers` that `?search=` is now consumed by
   the typeahead pickers (no contract change — the params are Phase 14's).
2. **`requirements.md`** — an eighth "no new FR" note, the kin of Phases 11 and 14:
   FR-004 (view products), FR-020 (record stock-in, "…and supplier"), and FR-031
   (view the history) all read exactly as before — a searchable field and a
   server-side count are a screen affordance plus transport, not a user goal in
   `product.md` §4.
3. **`business-rules.md`** — a seventh "no new BR" line: searching a list and counting
   its members are not rules about the business; BR-013 (inactive suppliers can't be
   selected), BR-070–074 (who may read what) say what they said before. The category
   count is `COUNT(*)` on read, the same "never a stored column" posture as BR-040/042.
4. **`architecture-observations.md`** — a new Phase 17 section: the
   unbounded-catalogue-reads precondition (this file's third) is now **retired for
   `/products` and `/suppliers`** — after this phase neither route has a caller that
   asks for the whole set; it **survives only on `GET /categories`** via
   `Store.loadReferenceData`, by decision, because that set is small and fixed. Record
   the shared `typeahead.js` module (a second frontend module with real behaviour and
   its own test, after `pager.js`), and the category-count query (**no migration** — a
   `getRawAndEntities` computed column, the Phase 14 Fork B pattern reused).
5. **`product.md` §11** — a Phase 17 cross-reference in the Phase 7/10/11/14/15/16
   register: same shape as Phase 14's — §4 gains no user goal, §5 no use case, §7 no
   scope; Q-4 and Q-7 remain open, untouched since Phase 5.
6. **`domain-model.md`** — **no change**, stated here because a reader will check:
   nothing about an entity, relationship, invariant, or column. `productCount` is a
   read-time projection, not a stored field.
7. **`README.md`** — Current phase to Phase 17; the supplier field and the History
   product filter are now type-to-search; the Categories count is server-side; **no
   migration this phase**.
8. **`docs/learning-notes/frontend-module-architecture.md`** — add `typeahead.js` to
   the module graph and a line on why it is a module (shared behaviour, its own test)
   rather than a `UI.*` helper.

---

## 5. Testing plan

- **Integration — `common/catalogue-paging.integration.spec.ts`** (the consolidated
  suppliers/categories/users spec; real Postgres): a fixture with categories owning
  0 / 1 / several products plus one uncategorised product — the paged rows carry the
  right `productCount` including `0`, the value is a JS `number` (not a bigint
  string), and the **no-param path returns bare `Category` rows with no
  `productCount` key** (the reference-cache contract guard).
- **E2E — `test/categories.e2e-spec.ts`**: `GET /categories?page=1&pageSize=…` items
  carry a numeric `productCount` that tracks products created over HTTP; `GET
  /categories` (no param) items have no `productCount`. Owner-only gate and the
  Phase 14 paging cases are unaffected.
- **Existing specs — a diff here is a regression, not a fixture artefact** (Phase 11
  §5's rule): the Phase 14 paging spec and every catalogue e2e still pass unedited —
  the bare-array default is unchanged.
- **Frontend — `frontend/test/typeahead.test.js` (jsdom), new:** focus queries the
  first page and opens the menu; typing debounces to a single `search` with the
  trimmed query; selecting an option commits `{ id, label }`, fills the input, closes
  the menu, shows the clear button; `total > shown` renders `+N more`; clear reports
  `null` and restores `emptyLabel`; a slow earlier response resolving after a newer
  one does not overwrite it.
- **Frontend — `frontend/test/history-filter.test.js` (jsdom), new:** `historyView`
  mounts the typeahead into `#h-product` and loads the unfiltered log once; focus
  queries `pageSize: 20` (a bounded page, not the catalogue); picking a product
  re-requests the log with that `productId` and the label survives the re-render.
- **Manual smoke walk**, both roles, frontend on `serve.js` + backend on `:3000`,
  seeded DB:
  - **Stock In**: type in the supplier field → matches appear → pick one → Review
    shows that supplier's name → Confirm saves it. Also record a stock-in leaving the
    supplier empty ("— No supplier recorded —").
  - **Inventory History**: type a product name into the filter → the list narrows to
    that product; clear (`×`) → back to all products; the type/days selects still work.
  - **Categories**: each row's "N products" matches the Products list filtered by that
    category; create/delete a product and reload → the count moves.
  - **Regression**: a fresh login still fills the product-form category dropdown; the
    Products / Suppliers / Users list screens and their pagers are unchanged.
  - **Narrowing**: with a catalogue larger than 20 matches (search a common
    substring), the picker shows `+N more — keep typing to narrow` and never a
    silently truncated list.

---

## 6. Rollout order

Leaves-first, bootable at every step, in the manner of Phases 11–16.

1. **`CategoriesService.findAll` — `productCount` on the paged branch**, plus the
   integration and e2e cases. Individually shippable: an additive field on a response
   only the admin screen requests, with no frontend consumer yet.
2. **`frontend/typeahead.js` + CSS + `typeahead.test.js`.** No view imports it yet.
3. **`views/categories.js`** — consume `productCount`, delete the `/products` fetch.
4. **`historyView`** — product filter → typeahead, `history-filter.test.js`.
5. **`transactionWizard`** — stock-in supplier picker → typeahead.
6. **The manual smoke walk** (§5), both roles.
7. **Documentation** (§4).

Steps 3–5 are independent of each other. **If cut short, stop after step 1 or 2** —
the app is shippable with no visible change. Stopping mid-view (3–5) leaves one picker
converted and the others not, which is coherent but half a feature.

---

## 7. Explicitly out of scope for Phase 17 (Future)

- **The `CATEGORIES` reference cache's unbounded `GET /categories`** and the
  product-form category `<select>` (Fork D). Categories are a small fixed set; a
  typeahead there is worse UX for no gain. **Trigger:** a deployment that
  accumulates categories in the hundreds — which nothing in `product.md` §3's "1–10
  people" shop suggests.
- **`DashboardService`'s whole-catalogue `productsRepository.find()`** (issue #9) —
  a summary reporting `lowStockCount` inherently needs every product; it is not a
  paging problem. Reusing a computed-in-SQL query to drop its second round-trip is a
  legitimate follow-on, not ridden along here.
- **Cursor / keyset pagination** anywhere (Phase 14 Fork A) — offset is adequate for
  a name-ordered catalogue; the pickers query the same paged routes.
- **An index on `products.name` / `suppliers.name`** (issue #14) — `?search=` is an
  `ILIKE '%…%'` scan; still not on the evidence bar. `EXPLAIN` and add one only if a
  realistic row count shows it needs one.
- **`minChars > 0`, recent/favourite suggestions, a "create new supplier from here"
  affordance** in the pickers — none are asked for; the wizard already links out to
  supplier management.
- **Deleting the `mockFetch` / `?state=` scaffolding** (Phase 13 §7 / issue #10) —
  untouched again, same trigger.
- **A shared throttle store** (issue #11) and **an `audit_events` retention policy**
  (issue #12) — still parked, still recorded in `architecture-observations.md`.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] The stock-in wizard's supplier field and the Inventory History product filter
      are search-as-you-type controls querying `GET /suppliers?search=&status=active`
      and `GET /products?search=` a page (20) at a time — not a `<select>` of every
      row. When more match than are shown, the control says so
      (`+N more — keep typing to narrow`).
- [x] The Categories screen reads each row's `productCount` from the server on its
      existing paged `GET /categories` call — the whole-catalogue `Store.listProducts()`
      fetch and the client-side `.filter().length` are gone.
- [x] `GET /categories` with **no** paging param is byte-for-byte unchanged — a bare
      `Category[]` with no `productCount` key — proven by an integration assertion and
      an e2e assertion, because that is the `CATEGORIES` reference-cache contract.
- [x] `GET /products` and `GET /suppliers` have **no remaining caller that fetches the
      whole set**; `architecture-observations.md` records the unbounded-read
      precondition as retired for those two and surviving only on the `/categories`
      reference-cache path (Fork D), by decision.
- [x] `frontend/typeahead.js` is one module, shared by both pickers, with a
      `frontend/test/typeahead.test.js` (jsdom) covering the debounce, the
      stale-response guard, select, clear, and the "+N more" line; every listener is
      factory-attached (Phase 13 invariant).
- [x] **No migration** — the category count is a `getRawAndEntities` computed column
      (the Phase 14 Fork B pattern), and `README.md` says so.
- [x] **No domain document changed** beyond a `product.md` §11 cross-ref, an eighth
      "no new FR" note in `requirements.md`, and a seventh "no new BR" line in
      `business-rules.md`; `domain-model.md` not at all; `api.md`'s route list gains
      no route.
- [x] Every fork decided and recorded either way: count shape (A), picker page size
      and the "more" affordance (B), one typeahead module vs. a pure core (C), the
      categories reference cache (D), the debounce/pageSize knobs (E), keeping a
      picked value across a re-render (F).
- [x] Full backend suite green — `nest build`, `lint:check`, `npm test`,
      `npm run test:e2e` — and the frontend `node --test` suite green.
