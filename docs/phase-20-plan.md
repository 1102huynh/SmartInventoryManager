# Phase 20 Plan — Remove the `mockFetch` / `?state=` mockup scaffolding

Status: Phase 20 — Planned
Last updated: 2026-09-07
Scope decided with the project owner: **delete `UI.mockFetch`, `UI.previewControl`, and
the per-view `override` / `?state=` machinery from `frontend/`** — the Phase 1
navigable-mockup scaffolding that was carried unchanged through the Phase 13 split — and
nothing else. This is issue #10, and it is the trigger Phase 13 §7 wrote down for itself:

> **Deleting the `mockFetch` / `?state=` scaffolding** (§2). Phase 1 mockup machinery
> that still works. **Trigger:** when someone decides the real backend's error and empty
> states can be exercised another way in development; until then it is moved unchanged,
> not removed, because deletion is a behaviour change and this phase makes none.

Scoped the same way every phase in this series has been: one headline change, an explicit
out-of-scope list, no punch-list riding along.

## Why this phase, why now

Six list views (`dashboard`, `products` list, `suppliers` list, `audit`, `approvals`,
`history`) each carry the same three pieces of Phase 1 scaffolding:

1. A `let override = 'normal'` state variable.
2. `UI.previewControl(override)` in the toolbar — a dashed-border `<select>` offering
   *Normal / Loading / Empty / Error*, rendered on every screen, in front of every user.
3. The load path wrapped in `UI.mockFetch(factory, { forceState })`, whose `factory`
   branches on `override === 'empty'` to hand back a hard-coded empty payload and whose
   `forceState: 'error'` rejects with a canned message instead of calling the API.

It let a Phase 1 reviewer preview the empty and error panels without a backend. Phase 2
gave the app a real backend; Phase 13 moved the seam intact and said, in as many words,
that removing it was "a behaviour change and a separate decision, with its own trigger in
§7." That trigger is now met:

- **The real states are reachable other ways.** An error panel shows if you stop the API
  (`serve.js` still serves the static modules; `Store._request` throws the fetch failure)
  or point `window.API_BASE` at a dead port. An empty panel shows against a freshly
  seeded-then-emptied database, or any filter that matches nothing. Neither needs an
  in-page control.
- **It is user-visible.** `previewControl` is not dev-gated — there is no build step and
  no `NODE_ENV` on the frontend (Phase 13 Fork A2/A3), so the "Preview state" `<select>`
  ships to production on six screens. "Not part of the real product" (its own source
  comment) is contradicted by it being *in* the real product.
- **It distorts the code it lives in.** Every one of the six `load()` functions reads
  through a `mockFetch` indirection and an `override === 'empty'` branch that exist only
  for the mockup. Removing them makes each view's data path `Store.x().then(render).catch(errorState)` — what it looks like it should already be.

**Honesty about the trigger, in the register this project uses:** nobody has hit a bug
here, and the scaffolding still works exactly as built. What makes now the time is that
Phase 13 §7 named a concrete condition, the condition holds, and the four later phases
(14–17, 19) that re-listed this as "out of scope, Phase 13 §7" each did so noting *no new
information* — the re-deferral this project's own standard rejects once the trigger is
actually met.

**This phase changes no domain document.** No FR (a review-only preview control is not a
user goal — §4), no BR, no entity, no route, no backend file, no migration. The only
observable change is the removal of a control that was never part of the product.

---

## 1. Design decisions

### Fork A — delete `mockFetch` outright, or keep it as a thin pass-through. Recommended: delete it

`UI.mockFetch(factory, { forceState })` today does two things: reject with a canned error
when `forceState === 'error'`, and otherwise `Promise.resolve().then(factory)`. Strip the
`forceState` caller (Fork B) and the second branch is `Promise.resolve().then(factory)` —
a wrapper that adds one microtask tick and nothing else.

- **A1 — delete `UI.mockFetch` and `UI.previewControl` from `ui.js`; each view calls its
  `Store.*` method directly.** The `.then(render).catch(errorState)` chain a view already
  has works unchanged on the promise `Store.*` returns. **Recommended.**
- **A2 — keep `mockFetch` as `f => Promise.resolve().then(f)`.** Rejected: a
  no-op indirection named after a thing it no longer does. Phase 13's own rule ("relocate,
  don't improve") cuts the other way now that improvement is the point.

The one real effect of the wrapper — guaranteeing a `Promise` even when a view's factory
synchronously returned the `override === 'empty'` literal — disappears with Fork B, since
`Store.*` methods are all `async`.

### Fork B — the `override === 'empty'` branches. Recommended: delete, and keep the copy split

Each view's `mockFetch` factory has an `if (override === 'empty') return { items: [], … }`
line, and its `body()` / `emptyState()` call has a matching
`override === 'empty' ? 'No X yet' : 'No matching X'` ternary picking between two sets of
empty-state copy.

- **B1 — delete the `override` branch in the factory; in `body()`, choose the copy from
  whether any real filter is active.** `products` / `suppliers`: no `search` and no status
  filter → "No X yet"; otherwise "No matching X". `audit` / `history`: no `type` /
  `productId` / `days` → "nothing recorded yet"; otherwise "no match". `approvals`: the
  default `status === 'pending'` with no product/day filter → "Nothing to approve";
  otherwise "No matching requests". This *keeps* both messages — they are good copy — and
  makes the app show the right one on its own, which the `override` control was faking.
  **Recommended.**
- **B2 — collapse to a single "no results" message per screen.** Rejected: "No products
  yet / Add your first product" and "No matching products / clear the filters" are
  genuinely different situations and the wording helps. Deleting the scaffolding should
  not cost the user the better of the two messages.

### Fork C — leave `dashboard.js`'s unused `query` parameter. Recommended: leave it

`dashboard(container, query)` never reads `query` (it did not before this phase either).
The router calls every view as `view(container, parseQuery(...))`. Touching the signature
is a router change for no gain.

- **C1 — leave it.** **Recommended.** One consistent view signature; the lint tree has no
  `no-unused-vars` on function parameters for the frontend (there is no frontend eslint).
- **C2 — drop the parameter.** Rejected: it makes `dashboard` the one view with a
  different arity, for a cosmetic saving.

---

## 2. What's new

Nothing. This phase only deletes. No new file, dependency, module, route, or migration.

| File | Change |
|---|---|
| `frontend/ui.js` | Remove `mockFetch` and `previewControl` (and their comment block). |
| `frontend/api.js` | Rewrite the header comment that described the seam as deliberately preserved. |
| `frontend/views/dashboard.js` | Drop `override`; `load()` calls `Store.getDashboardSummary()` directly; `headerHtml()` drops `previewControl`; `attach()` drops the `#preview-select` listener; retry handler becomes `load`. |
| `frontend/views/products.js` | Same shape; `body()`'s empty-state copy now keys off `!search && !category && status === 'all'`. |
| `frontend/views/suppliers.js` | Same shape; empty-state copy keys off `!search && !status`. |
| `frontend/views/audit.js` | Same shape; empty-state copy keys off `!eventType && !subjectUserId && !days`. |
| `frontend/views/approvals.js` | Same shape; empty-state copy keys off `status === 'pending' && !productId && !days`. |
| `frontend/views/transactions.js` | `historyView` only; empty-state copy keys off `!type && !productId && !days`. |
| `frontend/styles.css` | Remove the two `.preview-state` rules. |
| `frontend/test/products-list.test.js` | One stale comment (`mockFetch promise chain`) reworded; the test itself is unaffected — it stubs `Store.listProducts`, which the view now awaits directly. |

No backend file, no `serve.js`, no `index.html`, no `router.js`, no `config.js`. The
frontend still needs no `npm install` to serve (jsdom stays the one devDependency, for
the existing test).

---

## 3. Backend changes

**None.** No controller, service, DTO, entity, or migration. `nest build`, the unit /
integration / e2e suites are all untouched and not re-run for this phase (nothing they
cover changed).

---

## 4. Documentation updates

1. **`requirements.md`** — a tenth "no new FR" note, beside Phases 7, 8, 10, 11, 14, 15,
   16, 17, 19. A review-only preview `<select>` is not a user goal; FR-004, FR-012,
   FR-031, FR-050, FR-065, FR-066 read exactly as before, and none of them ever mentioned
   it.
2. **`business-rules.md`** — a "no new BR" line, the ninth such (after Phases 10, 11, 15,
   14, 16, 17, 19 — Phases 12 and 18 added rules in between). Nothing about the business
   changes; the empty/error *panels* are unchanged, only the fake way of forcing them is
   gone.
3. **`architecture-observations.md`** — a Phase 20 cross-cutting section: the last piece
   of Phase 1 mockup scaffolding is gone; Phase 13's §7 trigger for it fired exactly as
   written; the six `load()` functions now read
   `Store.x().then(render).catch(errorState)` with no indirection; the reason it waited
   this long (Phase 13's "relocate, don't improve" discipline) and the reason it moved now
   (the trigger's condition met, and named re-deferrals with no new information).
4. **`README.md`** — Current phase to Phase 20; Phase 19 moves down to "Earlier phases".
   One line: no migration, no backend change, the "Preview state" control is gone from the
   six list screens and the real empty/error panels are reached the ordinary way.
5. **`product.md` §11** — a one-line Phase 20 entry in the register every phase gets, in
   the Phase 7/10/11/14–17/19 "no scope change" shape: §4/§5/§7 unchanged, no
   `domain-model.md` change, issue #10 / Phase 13 §7 named.
6. **`api.md`** — **no change**, stated here because a reader will check: this phase does
   not touch a route, a response, or a status code. The standing "no route's shape
   changes" line already covers it.
7. **`domain-model.md`** — **no change**: nothing about an entity, relationship,
   invariant, or column.

The four later phase plans (14, 15, 16, 17) and Phase 18 that each list "deleting the
`mockFetch` / `?state=` scaffolding (Phase 13 §7)" as out-of-scope are **left as
written** — they are dated records of what each of those phases chose, and the entry was
accurate when made. Phase 20's own docs are where "now done" is recorded.

---

## 5. Testing plan

- **Frontend `node --test` — unchanged, passes unedited.** `products-list.test.js`
  stubs `Store.listProducts` and drives the view's real `attach()` wiring; the view now
  awaits that stub directly instead of through `mockFetch`, and the `tick()` helper
  (`setTimeout(r, 0)`) still lets the `.then` chain settle. `pager.test.js`,
  `history-filter.test.js`, `stock-out-reason.test.js`, `typeahead.test.js` never touched
  the scaffolding. Full suite green (28 tests) is the regression proof.
- **Manual walk of the six screens** against a running backend:
  - Each list loads, renders rows, paginates where it paginated before.
  - Stop the backend, hit Retry → the real `errorState` panel with the fetch-failure
    message; start it, Retry → recovers.
  - A filter that matches nothing → "No matching X" copy.
  - An empty database (or a role/scope that legitimately sees nothing, e.g. a Staff
    member on Approvals with no submissions) → the "nothing yet" copy.
  - No "Preview state" `<select>` anywhere; toolbars are unchanged otherwise.
- **`grep -r "mockFetch\|previewControl\|preview-select\|forceState\|\boverride\b" frontend/`**
  returns nothing — the mechanical completeness check.

No new automated test. Phase 13 §7's frontend-test trigger ("the first phase that adds
genuinely new frontend *logic*") is explicitly *not* met by a deletion; adding a jsdom
error-panel test here would be testing behaviour this phase did not introduce.

---

## 6. Rollout order

One reviewable step — the change is a coordinated deletion and the app must boot at the
end, not between files.

1. **`ui.js`** — remove `mockFetch` + `previewControl`. The app will not boot again until
   step 2 (six views reference them), so 1 and 2 land together.
2. **The six views** — remove `override`, the `previewControl` call, the `mockFetch`
   wrap, the `override === 'empty'` branch, the `#preview-select` listener; rewrite each
   empty-state condition (Fork B1); simplify each retry handler to `load`.
3. **`styles.css`, `api.js` comment, the test comment.** Cosmetic tail.
4. **Documentation** (§4).

**If cut short, revert the branch** — there is no half-state worth shipping. Unlike a
backend refactor, no individual file here is independently valuable.

---

## 7. Explicitly out of scope for Phase 20 (Future)

- **A real dev-only fixture / mock-API layer.** If forcing arbitrary backend states in
  development ever becomes routine again, the answer is a mock service worker or a
  `?mock=` server mode — *outside* the view code, dev-gated — not the return of an
  in-component `<select>`. Not needed now; listed so the deletion is not read as "we can
  never preview states."
- **A frontend test harness for the error/empty panels** (Phase 13 §7's other trigger,
  still unmet — this phase adds no new logic).
- **Touching `users.js` / `categories.js` / the wizards.** They never carried the
  scaffolding; `categories`' and `users`' list loads already call `Store.*` directly and
  are the pattern the six views now match.
- **Splitting `styles.css`** (Phase 13 Fork D) — removing two rules does not change the
  one-file calculus.
- **Any backend change**, any `serve.js` change, any route change.
- **Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [ ] `UI.mockFetch` and `UI.previewControl` no longer exist in `frontend/ui.js`.
- [ ] No view has an `override` variable, a `#preview-select` element, or an
      `override === 'empty'` / `forceState` reference —
      `grep -r "mockFetch\|previewControl\|preview-select\|forceState\|\boverride\b" frontend/`
      is empty.
- [ ] The `.preview-state` CSS rules are gone from `styles.css`.
- [ ] Every one of the six `load()` paths is `Store.x().then(render).catch(errorState)`
      with no wrapper; every retry button re-runs `load`.
- [ ] Each screen still shows a "nothing yet" empty state for a genuinely empty list and
      a "no matches" empty state for a filter that excluded everything (Fork B1) — no copy
      was lost.
- [ ] Stopping the backend and hitting Retry shows the real `errorState` panel; no screen
      renders a "Preview state" control.
- [ ] Frontend `npm test` green (28 tests), unedited except the one stale comment.
- [ ] **No backend change, no migration, no domain-document change** — `requirements.md`
      gets a tenth no-FR note, `business-rules.md` a ninth no-BR line, `api.md` and
      `domain-model.md` nothing. `README.md` and `product.md` §11 say so.
- [ ] Every fork decided and recorded: delete vs. keep `mockFetch` (A), the
      `override === 'empty'` branches and empty-state copy (B), `dashboard`'s unused
      `query` param (C).
