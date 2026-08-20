# Phase 4 Plan — Category CRUD & Documentation Cleanup

Status: Phase 4 — Complete
Last updated: 2026-08-20
Scope decided with the project owner: **Category CRUD is Phase 4's headline feature**
— closing FR-005, the one remaining Should-have gap `phase-3-plan.md` explicitly
deferred ("Category CRUD (FR-005) and other Should-have polish stay out of this
phase; revisit as Phase 4"). The rest of this phase is the punch-list
`phase-2-comprehensive-review.md` raised before Phase 3 and that Phase 3 (being
scoped tightly to auth) didn't touch — some of it has since been fixed in passing,
some hasn't, and this plan sorts out which is which before adding new work on top.

## 0. Where things actually stand right now

Before planning new work, here's what a fresh read of the current `develop` branch
(post Phase 3) shows against the Phase 2 review's punch-list, since some items
turned out to already be resolved:

| Phase 2 review item | Status now |
|---|---|
| `AllExceptionsFilter` fallback path untested | **Resolved** — `all-exceptions.filter.spec.ts` now exists. |
| `ProductsService` had no focused unit test | **Resolved** — `products.service.spec.ts` now exists. |
| `DashboardService` had no unit test | **Resolved** — `dashboard.service.spec.ts` now exists. |
| `needsAttention` out-of-stock-without-threshold edge case undecided | **Resolved**, including in docs — `business-rules.md` already has BR-062 as of the Phase 2.1 review commit, matching what `dashboard.service.ts` cites. This item turned out to already be closed before Phase 4 started; restated here only for the record. |
| "Date cannot be in the future" missing from `business-rules.md` | **Still open** — `InventoryService.assertNotFuture` enforces it on all three writes exactly as before, still with no BR-id anywhere in the doc. |
| `backend/README.md` still the generic Nest CLI starter | **Still open** — unedited since project bootstrap (donation links, generic description, etc.), while the root `README.md` remains project-specific. |
| `CategoriesService` / `UsersService` had no unit tests | **Partly moot** — `UsersService` is now correctly documented as read-only by design (no signup; backs `GET /auth/me`), so it doesn't need one. `CategoriesService` is still untested, and about to grow in this phase anyway. |
| Dashboard's `getSummary` does two unfiltered `listAll()` calls | **Still true, still fine** — no change proposed; restated here only so it isn't silently dropped from the record. |

So this phase has two honest categories of work: build FR-005, and close the items
above that are still actually open (the future-date rule and the backend README —
BR-062 turned out to already be done; `CategoriesService` tests fall out of building
FR-005 anyway).

---

## 1. Design decisions

### Category stays a plain, status-less entity — no Active/Inactive
`Product` and `Supplier` both got a status flag because *in-use* records of those
kinds still need to be excludable from new transactions while remaining visible in
history (BR-002, mirrored for suppliers). A `Category` has no transactions of its
own and no behavior beyond classification (`domain-model.md` §4) — there's nothing
for an "inactive" category to *do* differently from a deleted one. Adding a status
column here would be copying the Product/Supplier pattern reflexively rather than
because this entity needs it.

### Delete is a real delete, not a soft-delete-with-history-guard
`Product.remove` and (by the same logic) supplier deactivation exist because
`InventoryTransaction` rows reference them and BR-004 requires that history survive.
`Category` is different by construction: the existing migration already defines
`products.category_id`'s foreign key as `ON DELETE SET NULL`
(`1787122164465-InitSchema.ts`), not `RESTRICT`. That was a deliberate choice made
back in Phase 2 (`category.entity.ts`'s own comment: "no behavior of its own beyond
classification") — deleting a category was always meant to be safe, orphaning any
products that referenced it back to "Uncategorized" rather than being blocked. This
phase's `CategoriesService.remove` just needs to call the repository's delete; the
database already does the correctness work. No `hasHistory`-style guard is needed
or appropriate here — building one would silently contradict a decision already
encoded in the schema.

### Q-5 (flat vs. hierarchical) resolved: flat
`Category` has never had a `parentId` — the entity, the migration, and A-7
("categories are a light organizational aid... not required for MVP correctness")
all already assume a flat list. This phase makes that the recorded answer to Q-5
rather than an open question, since nothing about building CRUD changes the
argument for staying flat: a small business's product list doesn't need
subcategories, and adding hierarchy now would be solving a problem nobody has
asked for yet (the same "don't build for a need that doesn't exist" reasoning
`phase-3-plan.md` used for refresh tokens).

### Name uniqueness: service-level check backed by the existing DB constraint
`categories.name` already has a `UNIQUE` constraint (`category.entity.ts`,
`@Column({ unique: true })`). Following the exact pattern `ProductsService` already
established for SKU (`assertSkuAvailable`), `CategoriesService.create`/`update` gets
an `assertNameAvailable` check that turns a Postgres unique-violation into a clean
`409 Conflict` with a readable message, rather than letting a raw driver error leak
through `AllExceptionsFilter`'s generic-500 path.

### No new permission model
Every write in this app is currently gated only by "authenticated or not" (Phase
3's `JwtAuthGuard`) — `role` on `User` is descriptive, not enforced, and A-5 stays
deferred exactly as `product.md` states. Category CRUD doesn't introduce a
"managers only" rule; any authenticated user who can create a product can create a
category, consistent with every other write endpoint in the system today.

---

## 2. What's new (backend)

### DTOs
- `CreateCategoryDto` — `name: string` (`@IsString() @IsNotEmpty() @MaxLength(100)`,
  matching the length precedent set by `Product.name`/`Supplier.name`).
- `UpdateCategoryDto` — `PartialType(CreateCategoryDto)`, matching the pattern
  `UpdateProductDto`/`UpdateSupplierDto` already use.

### `CategoriesService` — three new methods
- `create(dto)` — `assertNameAvailable`, then insert.
- `update(id, dto)` — look up or `404`; if `dto.name` is being changed,
  `assertNameAvailable` again (excluding the category's own current row, the same
  "only re-check when it actually changed" guard `ProductsService.update` uses for
  SKU).
- `remove(id)` — look up or `404`, then delete. No history/usage guard (see Design
  decisions above) — the FK's `ON DELETE SET NULL` is the correctness mechanism,
  not application code.

### `CategoriesController` — three new routes

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/categories` | `{ name }` | `201` + the created category; `409` on duplicate name. |
| PATCH | `/categories/:id` | `{ name }` | `404` if the category doesn't exist; `409` on rename to a name already in use. |
| DELETE | `/categories/:id` | — | `204`. Any product currently pointing at this category has `categoryId` set to `null` by the database, and shows as "Uncategorized" in the UI — same as today for a product created without one. |

`GET /categories` (existing, unchanged) stays the read used by the product
filter/picker.

---

## 3. Frontend changes

Today `CATEGORIES` is loaded once after login and used only as a read-only picker
inside the product list filter and the product create/edit form (`index.html`
lines ~411, ~992, ~1219) — there is no screen where categories themselves are
managed; they'd have to be inserted directly in the database today.

This phase adds a small **Categories** admin screen, following the same
list-with-inline-actions pattern the app already uses for Suppliers rather than
inventing a new UI convention:

- A simple list of existing categories (name + product count, computed client-side
  from `Store.listProducts()` or added as a lightweight backend aggregate if that
  turns out to be awkward — decide once building, not worth over-specifying here).
- Inline rename (click to edit, matching the app's existing lightweight-form
  style) and a delete action with a confirmation step, since delete is
  irreversible and — per the design decision above — silently uncategorizes any
  products using it. The confirmation copy should say so explicitly ("N products
  will become uncategorized") rather than a generic "are you sure?", so the
  consequence is visible before the click, not discovered after.
- A simple "add category" inline form (name only).
- `Store` gains `createCategory`, `updateCategory`, `deleteCategory` wrapping the
  three new endpoints, and re-populates `CATEGORIES` after each mutation (the same
  refresh-after-write pattern `Store` already uses elsewhere) rather than
  hand-patching the in-memory array.
- Entry point: a "Manage categories" link from the product list's category filter
  area, consistent with how the app surfaces admin actions contextually rather
  than through a separate nav section.

---

## 4. Documentation fixes (carried over from Phase 2's review, not new findings)

1. **Add `BR-062` to `business-rules.md`** under Low Stock, matching what
   `dashboard.service.ts` already cites in its comment: *"`needsAttention` is the
   low-stock list only, not merged with out-of-stock; a product with no threshold
   configured is never flagged, consistent with BR-061."* This isn't a new
   decision — it's writing down one the code already made and pointed at, so the
   citation stops dangling.
2. **Add a rule for "transaction date cannot be in the future"** — proposed as
   `BR-052` under Inventory History (applies identically to stock-in, stock-out,
   and adjustment, so it belongs with the shared rules rather than duplicated
   under each transaction type). Implementation (`assertNotFuture`) doesn't
   change; only the doc gains the rule it's already enforcing.
3. **Rewrite `backend/README.md`** to match the root `README.md`'s project-specific
   style: what this backend is, how to set up the local Postgres + run migrations
   + seed, how to run the three test layers, and a pointer to `docs/` — replacing
   the generic Nest CLI starter content (donation links, Discord badges, etc.)
   wholesale.
4. **`requirements.md`**: flip FR-005's priority-table note from "Q-5: flat vs
   hierarchical categories" to record the resolution (flat — see §1 above) now
   that CRUD exists to act on it.
5. **`domain-model.md`**: Category's entity description currently says "has no
   behavior of its own beyond classification" — still true after this phase, but
   worth one added sentence noting create/update/delete now exist as of Phase 4,
   so a future reader doesn't assume it's still read-only-by-omission the way
   `phase-2-comprehensive-review.md` described it.

---

## 5. Testing plan

- **Unit** (`categories.service.spec.ts`, new) — `create` rejects a duplicate name
  with `409` (mocked repository throwing a unique-violation-shaped error);
  `update` only re-checks the name when it's actually changing (same "no-op
  submit shouldn't trip the guard" case `ProductsService.update`'s existing test
  covers for SKU); `remove` calls delete without any pre-check query (asserting
  the *absence* of a `hasHistory`-style lookup is itself the point — it's the
  test that would catch someone "helpfully" adding a guard that contradicts the
  `ON DELETE SET NULL` design decision).
- **E2E** (new cases in `test/app.e2e-spec.ts` or a new `test/categories.e2e-spec.ts`) —
  - create → `201`; duplicate name → `409`.
  - rename → `200`; rename to another category's existing name → `409`.
  - delete a category that a product currently references → `204`, then
    `GET` that product and confirm `categoryId` is now `null` (this is the one
    test that actually proves the `SET NULL` behavior end-to-end against a real
    database, not just documents the intent).
  - delete/rename a nonexistent id → `404`.
  - all four routes require a valid token (Phase 3's guard applies here with no
    special-casing, but worth one assertion confirming `@Public()` wasn't
    accidentally left on `CategoriesController` from before auth existed).
- **No new integration-layer test** — same reasoning `phase-3-plan.md` gave for
  auth: no concurrency-sensitive database behavior here for a mocked repository to
  misrepresent.

---

## 6. Rollout order

1. `CreateCategoryDto`/`UpdateCategoryDto` + the three new `CategoriesService`
   methods + unit tests. App still runs exactly as before — nothing exposes these
   yet.
2. `CategoriesController` routes + e2e tests (including the SET-NULL-on-delete
   case). This is the actual feature landing.
3. Frontend: Categories admin screen, `Store` methods, "Manage categories" entry
   point, delete-confirmation copy.
4. Documentation fixes (§4) — done last since several of them (the FR-005 note,
   the domain-model sentence) describe the feature that now exists, not one still
   being built.

---

## 7. Explicitly out of scope for Phase 4 (Future)

- Hierarchical categories / subcategories (Q-5 resolved as flat — see §1).
- Category icons, colors, or any display metadata beyond a name.
- Bulk re-categorization tooling (e.g., "move all products from category A to B").
- Category-based reporting or dashboard breakdowns — `dashboard.service.ts` stays
  scoped to what it already computes; a "stock by category" view is a separate,
  later ask if it comes up.
- Revisiting the two pre-existing, still-fine "not urgent" items from the Phase 2
  review (`dashboard.service.ts`'s two unfiltered `listAll()` calls) — restated in
  §0 for the record, not proposed as work here.

---

## 8. Definition of done

- [x] `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id` exist,
      require a valid token, and behave per §2.
- [x] Deleting a category in use sets referencing products' `categoryId` to
      `null`, proven by an e2e test against a real database.
- [x] `CategoriesService` has unit tests; all new e2e tests pass alongside the
      existing suite. (35 unit + 21 e2e, full backend suite, all green.)
- [x] Frontend has a Categories admin screen (list, create, rename, delete with
      explicit consequence-aware confirmation).
- [x] `business-rules.md` has `BR-062` (needsAttention — already present, predating
      this phase) and a new `BR-052` for the future-date check — no code comment
      cites a rule the docs don't have.
- [x] `backend/README.md` matches the root `README.md`'s project-specific style.
- [x] `requirements.md` (FR-005 note) and `domain-model.md` (Category description)
      updated to reflect CRUD now existing and Q-5 being resolved.
