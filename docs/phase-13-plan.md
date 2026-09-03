# Phase 13 Plan — Frontend restructuring (one file → a module graph)

Status: Phase 13 — Planned
Last updated: 2026-09-03
Scope decided with the project owner: **split `frontend/index.html`'s single 2,760-line
script and 284-line stylesheet into a set of small ES modules and one stylesheet,
served by the same `serve.js`, with no framework, no build step, and no new dependency —
and change no observable behaviour.** Scoped the same way `phase-3-plan.md` was scoped to
authentication and `phase-12-plan.md` to adjustment approval: one headline change, an
explicit out-of-scope list, no punch-list riding along. Unlike every phase from 3 to 12,
this one is **frontend-only and adds no capability** — it is the frontend's first
structural phase since the Phase 1 mockup, and its correctness criterion is that the app
after it is byte-for-byte the app before it.

## Why this phase, why now

Every phase since Phase 2 has been about the backend. `frontend/index.html` was written
in Phase 1 as a *navigable mockup* — one file was exactly right for a throwaway that
existed to validate workflows against `product.md` before any server existed
(`ui-open-questions.md` opens with that framing). It was never rewritten. Instead, ten
consecutive backend phases each reached into it and added: Phase 3 a real login screen
and token handling, Phase 5 role-gated buttons, Phase 6 the Users and Account screens,
Phase 9 the Audit Log, Phase 11 the truncation notice on four screens, Phase 12 the
Approvals screen and the wizard's second outcome. The mockup quietly became the product,
and it is now **3,061 lines in one file**: a 284-line `<style>` block, then a single
`<script>` holding a config layer, an `Auth` object, the `Store` API client, the `UI`
helper set, the router, and **sixteen** `Views.*` functions.

Nothing in that file is *wrong*. The problem is the one Phase 10 named for the backend's
`TIMESTAMP` columns and refused to keep deferring: a cost that only grows, incurred a
little at a time by every phase, with no single phase ever forced to pay it. Concretely,
in one file:

- **A change to one screen forces a reader to hold all sixteen in scope.** `Views.approvals`
  and `Views.userForm` share a lexical scope with fourteen other views and can only be
  reasoned about by trusting that none of the ~3,000 surrounding lines reaches into them.
  The backend does not work this way — it is sixteen-odd files under `src/`, one concern
  each, precisely so a reader of `AdjustmentsService` need not read `AuthService`.
- **Every frontend change in a phase touches the same file.** Phases 3, 5, 6, 9, 11 and 12
  each edited `index.html`; in a multi-developer world every one of those is a merge
  conflict against the same 3,000 lines. This project is small, but the argument
  `architecture-observations.md` makes for the backend's module seams — "one place to
  reason about a request" — has no frontend counterpart, and the asymmetry is now
  conspicuous.
- **The file mixes three languages and every layer of the app.** Structure (HTML shell),
  presentation (284 lines of CSS), the network client, the render helpers, the router,
  and every screen live in one `<script>`/`<style>` pair. A reader looking for "how does
  a request get its token" (`Store._request`) and a reader looking for "what does the
  dashboard render" (`Views.dashboard`) open the same file and scroll.

**Why now, and not as a grab-bag rider on a feature phase:** because it is a pure
refactor, it must land *alone*. If it rode along with a feature, a behaviour change and a
structural change would be entangled in one diff, and the one property this phase must
prove — *nothing changed* — would be unprovable. This is the same reason Phase 12 landed
its `applyApprovedAdjustment` extraction (step 3, "no behaviour change") as its own step
before the feature that used it: **a refactor that shares a commit with a behaviour change
cannot be verified as a refactor.**

**Why now rather than later** is the honest inverse of "why not sooner": the file has
crossed a threshold. At the 900 lines it was after Phase 3, one file was defensible. At
3,061 after Phase 12, the next feature phase's frontend work starts by scrolling past
sixteen views to find the seam it needs, and the phase after that is worse. The cost curve
is the argument, and it is the same curve Phase 12 §"Why this phase" invoked to close a
question that had been re-deferred with no new information seven times. This one has never
been raised at all — which is itself the finding: the frontend's structure has been
invisible because no phase was ever *about* it.

**This phase changes no domain document.** `product.md`, `requirements.md`,
`business-rules.md`, `domain-model.md`, and `api.md` are untouched — there is no new FR,
no new BR, no new entity, no route change, no response change. That is unusual enough
(only Phase 10 came close, and it still touched `business-rules.md` and `domain-model.md`)
that it is stated here at the top: **if this plan proposes editing any of those five files,
the plan has exceeded its scope.** The only documents that change are
`architecture-observations.md` (which finally gets a frontend entry) and `README.md` (the
frontend's run/layout section).

---

## 1. Design decisions

### Fork 0 — split the file at all, or leave it

This comes first because the rest of the plan is void if the answer is "leave it," and
because "leave it" is a real position this project's own minimalism could hold.

**The case for leaving it** is not weak. `serve.js`'s own comment states the project's
frontend creed: *"No framework needed for 'serve one HTML file'; adding one here would be
the unnecessary-abstraction the brief explicitly warns against."* One file has genuine
virtues this project prizes: there is exactly one thing to open, one origin, one
`Ctrl-F` reaches everything, and there is provably no module-resolution, load-order, or
bundler-configuration surface because none of those things exist. For a two-person shop,
"it's all in one file and it works" is a defensible end state, and a reader who has
watched this project refuse abstraction ten times running should expect that argument to
be taken seriously rather than waved past.

**Recommended: split it — into native ES modules only (Fork A), and nothing more.** The
deciding consideration is that this project's minimalism has never meant "one file"; it
has meant **"no abstraction that isn't paying for itself."** The backend is not one file,
and no one would propose making it one — it is many small files with one concern each,
and `architecture-observations.md` treats that as a virtue, not a compromise. The frontend
is one file for a reason that expired in Phase 1: it was a mockup. Splitting it by concern
brings the frontend to the same standard the backend already meets, and — this is the part
that makes it consistent with `serve.js`'s creed rather than a violation of it — **it can
be done with zero new abstraction**: no framework, no bundler, no build step, no
`node_modules`, no config file. Native ES modules are a browser feature, not a tool. The
file count goes up; the concept count does not.

**Rejected: split, but only cosmetically** (e.g. three `<script>` tags in the same HTML
file, or region-fold comments). It gets none of the benefit — still one file, still one
merge surface, still one lexical scope if the scripts share globals — while adding the
load-order fragility of plain `<script>` tags without the isolation modules give. If the
file is split, it is split into real modules with real boundaries, or not at all.

### Fork A — the mechanism: native ES modules, a bundler, or a framework

This is the sharpest decision in the phase and every other one depends on it.

- **A1 — native ES modules.** `index.html` becomes a thin shell that links one stylesheet
  and loads one `<script type="module" src="main.js">`; the JavaScript becomes a graph of
  `.js` files using `import`/`export`, served as static files by the existing `serve.js`.
  No build, no dependency, no tool. **Recommended.**
- **A2 — a bundler (Vite / esbuild).** Introduces `npm install`, a `node_modules`, a dev
  server, a production build step, and a config file to the frontend, which today has
  none of those.
- **A3 — a framework (React / Vue / Svelte).** A full rewrite of all sixteen views plus a
  build toolchain.

**A2 is rejected on `serve.js`'s own stated grounds.** The entire reason `serve.js`
exists — its comment says so — is that the frontend needs a real HTTP origin but *not* a
framework or a toolchain; it is "just enough to serve `index.html` over HTTP." A bundler
would delete `serve.js`'s reason to exist and replace it with the exact class of thing it
was written to avoid: a build step, a dependency tree, and a config surface, all to solve
a problem (module loading) that browsers solved natively years ago. The one thing a
bundler buys that native modules do not — collapsing many files into one HTTP request — is
a production-scale concern for an app that runs on `localhost:5173` against a `localhost`
API. **The trigger for revisiting A2 is concrete** (§7): if this frontend is ever deployed
to real users over a real network where sixteen serial module requests measurably hurt
first paint, a bundler earns its keep then — as a deployment-time optimisation of an
already-modular codebase, which is exactly the state this phase leaves it in. Splitting
into native modules now makes a future bundler *easier*, not redundant.

**A3 is rejected outright.** It is not a restructuring; it is a rewrite of the whole
frontend, it imports the largest abstraction in the industry to solve a file-organisation
problem, and it would throw away sixteen working, reviewed, behaviour-correct views to
retype them against a framework's lifecycle. Every reason `serve.js` gives against a
framework applies at ten times the strength. If a framework is ever wanted it is its own
multi-phase project with its own justification, not the tail of a refactor.

**A1's one genuine cost, stated rather than glossed:** native modules load over multiple
HTTP requests (one per file, plus the discovery waterfall of nested imports). On
`localhost` this is imperceptible; over a network it is real. That cost is the A2 trigger
above, and it is the *only* thing A2 would fix — so paying it now, on localhost where it
is free, and deferring A2 until it isn't, is the sequence that keeps every abstraction
paying for itself at the moment it is added.

### Fork B — shared mutable state across module boundaries. Recommended: one `session`/`state` module with accessors

This is the fork with a trap in it, because it is the one place the single-file design was
doing something that does not survive the split unchanged.

Two pieces of state today are module-level `let`s that one part of the file mutates and
another reads:

- **`CURRENT_USER`** — set by `Store.login()`, cleared by `Store.logout()`, read by the
  router (`renderApp`), the shell, and several views. Held in memory only, no
  `localStorage`, deliberately (Phase 3).
- **`CATEGORIES`** — the reference-data cache filled once by `Store.loadReferenceData()`
  after login and read by `UI.categoryChip` and `Store.getCategory`.

In one lexical scope, `let CURRENT_USER = null` mutated by one function and read by another
Just Works. Across ES modules it does not, and the reason is exact and easy to get wrong:
**an imported binding is a live, read-only view.** A module that does
`import { CURRENT_USER } from './session.js'` sees the latest value, but `CURRENT_USER = x`
in that importer is a compile error — you cannot reassign someone else's export. So the
naïve split — "move the `let` to `config.js` and import it everywhere" — compiles for
readers and breaks for the two writers (`login`, `logout`), and it breaks *loudly* (a
syntax error), which is the good failure, but only if you know to expect it.

- **B1 — a `session.js` (and `reference-data.js`) module that owns the state and exports
  accessor functions:** `getCurrentUser()` / `setCurrentUser(u)` / `clearSession()`, and
  `getCategory(id)` / `setCategories(list)`. Writers call setters; readers call getters or
  read a live-bound export. **Recommended.**
- **B2 — export a single mutable object** (`export const session = { user: null }`) and
  have everyone read and write `session.user`. It works — object *properties* are mutable
  across modules even though the binding isn't — and it is fewer lines. It is rejected
  because it re-creates in a new place the exact thing this phase is removing: unrestricted
  mutation of shared state from anywhere, now invisible across file boundaries instead of
  visible within one. An accessor makes "who is allowed to change the current user"
  greppable (it is the callers of `setCurrentUser`, and there are two), which is the same
  reason BR-082 keeps `actor` and `subject` as two explicit columns rather than one clever
  one: the explicit form answers the question the implicit form makes you reconstruct.

The trap, named so a reviewer checks for it: **the migration must not leave any writer
reassigning an imported binding.** The two writers are `Store.login` and `Store.logout`
(plus `loadReferenceData` for categories); all three move to calling setters. This is the
single most likely place for the refactor to introduce a real bug, and §5's smoke walk
exercises login/logout first for exactly that reason.

### Fork C — view-file granularity: one file per view, or grouped by resource. Recommended: grouped by resource, mirroring the backend

Sixteen `Views.*` functions could become sixteen files, or a smaller number grouped by the
domain resource they serve.

- **C1 — sixteen files, one per view.** Maximum isolation; also sixteen files for a
  two-person app, several of them (e.g. `Views.account`, `Views.userForm`) under 150 lines,
  and a `views/` directory a reader has to scan linearly to find "the products screens,"
  which are three separate files (`productList`, `productDetail`, `productForm`).
- **C2 — grouped by resource:** `views/products.js` (list + detail + form),
  `views/suppliers.js` (list + detail + form), `views/categories.js`, `views/users.js`
  (list + form), `views/transactions.js` (the wizard + global history),
  `views/dashboard.js`, `views/audit.js`, `views/approvals.js`, `views/auth.js`
  (login + account). **Recommended** — roughly nine view files, each mapping to a nav
  section and, not coincidentally, to a backend module (`ProductsModule`,
  `SuppliersModule`, `AdjustmentsModule`…). A reader who knows the backend's shape already
  knows where a screen lives.

C2 is recommended because the grouping is not arbitrary — it is the *same* decomposition
the backend already committed to, so the two halves of the app finally share one mental
model, and because "one file per function" is its own over-abstraction of the kind this
project routinely declines (it is the frontend equivalent of a per-method file). The exact
grouping is a detail the implementer may adjust by ±1 file where a view is unusually large
(`Views.transactionWizard` alone is ~290 lines and could justify its own file); the
principle — **group by resource, not by view, and let the nav and the backend modules be
the map** — is the decision, and it is what §3 lists.

### Fork D — the stylesheet: one file, or split by component. Recommended: one `styles.css`, extracted whole

The 284-line `<style>` block is already sectioned by banner comments (`TOKENS`,
`RESET/BASE`, `APP SHELL`, `BUTTONS`, `TABLE`, …). It could be extracted as one
`styles.css` or split into per-component files.

**Recommended: one `styles.css`, lifted out verbatim** and linked from `index.html`'s
`<head>`. Splitting CSS into many files needs either an `@import` chain (which adds serial
requests and is the CSS analogue of the module waterfall, for a stylesheet small enough
that it does not matter) or a build step to concatenate them (Fork A2, already rejected).
The banner comments already give the file its internal map; 284 lines is not a size that
benefits from physical splitting; and CSS is global-cascade by nature, so per-component
files buy less isolation than per-module JS does. One file, one `<link>`, no build. If the
stylesheet ever grows past the point where one file is navigable, splitting it is a later,
smaller decision with its own trigger (§7).

### What the shell becomes

`index.html` stops being the app and becomes its mount point: the `<head>` (the existing
Google-Fonts `<link>` plus a new `<link rel="stylesheet" href="styles.css">`), the empty
root element the router renders into, and one `<script type="module" src="main.js">`. It
should end up around thirty lines. Everything else in today's file moves out; nothing new
is invented.

### Why this is genuinely low-risk, on the evidence

The plan claims "no behaviour change," and that claim is only as good as the migration's
mechanical safety. Three facts from the current file make it safe:

- **Zero inline `on*=` handlers.** All 78 event bindings go through `addEventListener`
  inside each view's `attach()` function. This is the fact that makes module scope safe:
  the classic ES-module breakage — an inline `onclick="doThing()"` in a template string
  that silently stops resolving once `doThing` is no longer a global — **cannot occur here,
  because there are none.** (§5 re-asserts this with a grep that must stay at zero.)
- **Four `window.*` uses, all legitimate and all preserved:** `window.API_BASE` (config
  override), `window.scrollTo`, and two `window.addEventListener` calls (`hashchange`,
  `DOMContentLoaded`). None is an implicit global that the split would strand; each is a
  genuine browser API that reads identically from a module.
- **The namespaces are already clean seams.** `Auth`, `Store`, `UI`, `Views`, the router,
  and the config layer are already distinct objects that reference each other by name. The
  split turns each name-reference into an `import`; it does not have to *find* the
  boundaries, because the Phase 1 author already drew them — they were just all in one
  file.

`serve.js` needs **no change**: it already serves `.js` and `.css` with correct MIME types
and already resolves nested paths (its `path.join(ROOT, …)` plus the `../` guard handles
`/views/products.js` unchanged). That `serve.js` is untouched is itself evidence the split
respects the frontend's existing shape rather than fighting it — the server written to
"serve one HTML file" serves a module graph with no edit, because static files are static
files.

---

## 2. What's new (frontend)

Nothing is *new* in the sense of behaviour. What changes is where the existing code lives.
No new npm package, no new tool, no new config file, no build step, no change to `serve.js`
(§1). The proposed file layout under `frontend/`:

```
frontend/
  index.html            ~30-line shell: fonts + styles.css + <script type="module" src="main.js">
  styles.css            the extracted <style> block, verbatim (Fork D)
  serve.js              UNCHANGED
  main.js               entry: wires hashchange/DOMContentLoaded, calls boot()
  config.js             API_BASE, ROLE_LABEL, transaction-type maps, todayInputValue, the normalizers
  session.js            CURRENT_USER owner + getCurrentUser/setCurrentUser/clearSession (Fork B)
  reference-data.js     CATEGORIES cache + getCategory/setCategories (Fork B)
  api.js                the Store object: _request, auth, all domain calls, mockFetch
  ui.js                 the UI object: esc, icon, toast, emptyState, errorState, truncationNotice, categoryChip, navigate
  router.js             parseHash, renderApp, shellTemplate/navItem, updateApprovalsBadge, owner-only route gating
  views/
    auth.js             Views.login, Views.account
    dashboard.js        Views.dashboard
    products.js         Views.productList, Views.productDetail, Views.productForm
    transactions.js     Views.transactionWizard, Views.historyView
    suppliers.js        Views.supplierList, Views.supplierDetail, Views.supplierForm
    categories.js       Views.categoryList
    users.js            Views.userList, Views.userForm
    audit.js            Views.auditLog
    approvals.js        Views.approvals
```

The `Views = {}` registry pattern can stay (each view module attaches its functions to a
shared imported `Views` object) **or** views can be exported as named functions the router
imports directly. **Recommended: named exports the router imports** — it makes the router's
dependency on each view explicit and greppable, and removes the last piece of shared
mutable namespace. The `Views` object was a single-file convenience; in a module world the
`import` *is* the registry. This is a judgment the implementer may reverse if the registry
turns out to read better against the router's `switch`; it is called out because it is the
one place the split changes a pattern rather than relocating it.

### One thing to preserve deliberately: the `mockFetch` seam

`Store.mockFetch` and the `forceState` overrides (`?state=error`/`empty` on several views)
are Phase 1 mockup scaffolding that survived into the real app — they let a developer force
a screen's error/empty state without breaking the backend. This phase **moves them, and
changes nothing about them.** It neither deletes them (that is a behaviour change and a
separate decision, with its own trigger in §7) nor promotes them. A reviewer who sees them
land unchanged in `api.js` should find this sentence.

---

## 3. The migration, module by module

The order matters and is not alphabetical — it is leaves-first, so that at every step the
thing being moved imports only things already moved, and the app boots at every step.

1. **`styles.css`** — cut the `<style>` block to a file, add the `<link>`. Purely
   presentational; if the app looks identical after this single change, the CSS extraction
   is proven before any JavaScript moves. Independently shippable.
2. **`config.js`** — the pure constants and pure functions (`API_BASE`, `ROLE_LABEL`, the
   type maps, `todayInputValue`, the three `normalize*` functions). They import nothing;
   everything imports them. Leaves of the graph.
3. **`session.js` + `reference-data.js`** — the state modules (Fork B), with accessors.
   This is where the two writers (`login`/`logout`, `loadReferenceData`) switch to setters.
4. **`ui.js`** — the `UI` helpers; imports `config.js` and `reference-data.js`
   (`categoryChip` reads categories).
5. **`api.js`** — the `Store` client; imports `config.js`, `session.js`, `reference-data.js`,
   and `ui.js` (`navigate` on 401). Includes `mockFetch` unchanged (§2).
6. **`router.js`** — `parseHash`/`renderApp`/shell/nav; imports `session.js`, `ui.js`,
   `api.js`, and every view module. The hub.
7. **`views/*.js`** — one resource group at a time (Fork C), each importing `config`,
   `session`, `reference-data`, `ui`, and `api` as needed. Move one group, reload, walk
   those screens, move the next.
8. **`main.js` + the `index.html` shell** — the entry that registers the two `window`
   listeners and calls `boot()`, and the thirty-line HTML that loads it.

At no point is there a half-file: each step relocates a whole namespace, the app is
reloadable after each, and a regression is bisected to the one module that moved.

---

## 4. Documentation updates

Deliberately short, because this phase touches no domain document (§"Why this phase").

1. **`architecture-observations.md`** — the substantive entry, and the file's actual
   currency rather than a summary of this plan: **the frontend was a Phase 1 mockup that
   became the product across ten backend phases, and Phase 13 brought it to the module
   standard the backend has had since Phase 2.** The generalizable observation worth
   recording: the reason one-file was right in Phase 1 (a mockup validating workflows) and
   the reason it stopped being right (it silently became a 3,000-line app) are *different
   facts about the same file*, and the project noticed the second only when a phase was
   finally about the frontend itself. Plus the two decisions a future reader will
   re-litigate: **native ES modules over a bundler, on `serve.js`'s own stated grounds
   (Fork A), with the concrete deploy-time trigger that would flip it (Fork A2 / §7);** and
   **the frontend now decomposes by the same resources the backend does (Fork C).** Also a
   one-line note that `serve.js` was **unchanged**, because a reader will check whether a
   file split forced a server change and it did not.
2. **`README.md`** — the "Project layout" block's `frontend/` line ("Static HTML/JS UI")
   is now several files; update it to name the shell, `styles.css`, and the module graph in
   one phrase. The "Start the frontend" step (`node serve.js`, open `localhost:5173`) is
   **unchanged** — say so, because the whole point is that running it did not change.
   Update "Current phase" to Phase 13, in the register the file already keeps, with the
   one-sentence framing: **a pure frontend restructuring, no behaviour change, no new
   dependency.**

Explicitly **not** updated, and each would be a scope violation if it were:
`product.md`, `requirements.md` (no new FR — there is no new capability; this is the honest
inverse of FR-063/064/065/066, where a screen was a capability with a person behind it —
here there is no new screen and no new person), `business-rules.md` (no rule changed),
`domain-model.md` (no entity, no relationship), `api.md` (no route, no response, no header
changed — the API did not learn this happened). The learning notes are untouched unless the
implementer judges the ES-module state pattern (Fork B) worth a short frontend note; that
is optional and named as such, not required.

---

## 5. Verification plan

This phase has a different testing shape from every prior phase, and the difference is the
point: **the backend has an automated suite; the frontend has none.** It is vanilla
HTML/JS served statically, with no test runner, no jsdom, no Playwright — by the same
minimalism that kept it one file. This phase does **not** add one. Adding a frontend test
framework is a real decision with real dependency and tooling cost (the thing Fork A2 was
rejected for), it is not this phase's subject, and bolting it on here would entangle "did
the split preserve behaviour" with "does the new test harness work" — the entanglement
§"Why this phase" exists to avoid. Its trigger is in §7.

So verification is **a structured manual smoke walk plus two mechanical invariants**, and
because the correctness criterion is *identity*, the walk is run against the app before the
split as the baseline and after it as the comparison:

- **The two mechanical invariants**, checked with a command, not an eye:
  - `grep -noE 'on(click|change|submit|input|…)=' frontend/**/*.js` **stays at zero** — no
    step may introduce an inline handler that a global lookup would need (§1). It is zero
    today; it must be zero after.
  - **The browser console is clean on every screen** — no `Uncaught`, no
    `SyntaxError`, no failed module fetch, no "cannot reassign import" (the Fork B trap).
    A module that fails to load fails visibly in the console; a clean console across the
    walk is the module graph proving it resolved.
- **The smoke walk — every route, both roles, run identically before and after.** The
  app has sixteen views; the walk visits all of them. It leads with **login and logout**,
  twice (as Owner `alex@example.com`, as Staff `jordan@example.com`), because Fork B's
  state migration is the likeliest place to break and the session is what everything else
  depends on:
  - **Auth:** log in as Owner; confirm the shell shows "Alex … Owner"; log out; log in as
    Staff; confirm "Jordan … Staff" and that Owner-only nav items (Approvals, Audit, Users)
    are gated exactly as before; attempt a typed `#/audit` as Staff and confirm the same
    permission toast; change own password at `#/account`.
  - **Dashboard:** the four stat tiles, the two panels, the deep-links into filtered
    product views.
  - **Products:** list with each filter (all/active/inactive/low/out), detail (including
    the history panel and its truncation notice), add, edit, the lifecycle controls.
  - **Transactions:** the wizard for stock-in, stock-out, and adjustment — including the
    Phase 12 dual outcome (Owner → "recorded"; Staff → "Sent for approval"); global
    history with `?days=` and the truncation notice.
  - **Suppliers / Categories / Users:** list, detail, add, edit; role-gated buttons hidden
    for Staff.
  - **Audit** (Owner): the log renders, the truncation notice appears past 100 rows, the
    Users cross-link lands.
  - **Approvals** (Owner and Staff): Owner sees Approve/Reject with the recomputed delta;
    Staff sees their own requests read-only with Withdraw; the nav badge count.
  - **The `?state=error` / `?state=empty` overrides** on the screens that carry them
    render their error/empty panels (proving `mockFetch` moved intact, §2).
- **Verified the way Phase 10 and 12 verified their headline claims — by trying to make it
  go wrong.** The Fork B state migration is checked not only by "login works" but by
  confirming that a deliberate reintroduction of the naïve pattern (a view reassigning an
  imported `CURRENT_USER`) **fails to load with a console error**, so that the accessor
  discipline is enforced by the module system and not merely by convention. A split that
  "works" only because no one happened to reassign an import is a split one edit from
  breaking.

The honest limit, stated rather than hidden: a manual walk is weaker than an automated
assertion, and this plan does not pretend otherwise. It is the right level of rigour for a
*pure relocation of reviewed, working code* verified against a byte-identical baseline —
and the §7 trigger says exactly when that stops being true (the first phase that adds real
new frontend *logic* is the phase that should also add the test harness to cover it).

---

## 6. Rollout order

The migration order (§3) is leaves-first and boot-at-every-step, so the rollout is that
order with the discipline made explicit:

1. **`styles.css` extraction alone.** One change; the app is visually identical or the
   extraction is wrong. Individually shippable; nothing else depends on it.
2. **`config.js` + the two state modules** (`session.js`, `reference-data.js`), with the
   two writers switched to setters (Fork B). Boot, log in and out — the state migration is
   the risky part and it is exercised the moment it lands, not at the end.
3. **`ui.js`, then `api.js`, then `router.js`** — inner layers, each with a reload and a
   quick walk of a couple of screens after it.
4. **`views/*.js`, one resource group at a time** (Fork C). After each group, walk that
   group's screens. A regression is attributable to the one group that just moved.
5. **`main.js` + the `index.html` shell**, collapsing the old `<script>` to a module entry.
6. **The two mechanical invariants and the full smoke walk** (§5), both roles, against the
   pre-split baseline.
7. **Documentation** (§4) — `architecture-observations.md` and `README.md`. As in every
   phase in this series, the docs outlast the code and are not optional in any cut.

**If this phase is cut short, the coherent stopping point is after any numbered step**,
because every step leaves a bootable, behaviour-identical app — that is the property the
leaves-first order buys. Unlike Phase 12, there is **no genuinely bad half-state** here:
the worst case of stopping mid-way is a frontend that is *partly* split, which is ugly but
correct and shippable, not a stocktake correction vanishing behind a success message. The
one discipline that must not be skipped even in a cut: **step 1 (CSS) or any single module
extraction must not share a commit with a behaviour change** — the refactor's whole claim
is unprovable the moment it does (§"Why this phase").

---

## 7. Explicitly out of scope for Phase 13 (Future)

- **A bundler or any build step** (Fork A2). **Trigger, concrete:** the first time this
  frontend is deployed over a real network where the native-module request waterfall
  measurably hurts first paint. Then a bundler is a deployment-time optimisation of an
  already-modular codebase — which is the state this phase leaves it in, so the trigger's
  answer is cheap precisely because this phase ran.
- **A frontend framework** (Fork A3, React/Vue/Svelte). Not a restructuring; a rewrite,
  with its own justification and its own multi-phase project if it is ever wanted. Nothing
  here anticipates it, and the module split neither helps nor hinders a later framework
  adoption more than the current one file does.
- **A frontend test harness** (jsdom / Playwright / a runner). **Trigger:** the first phase
  that adds genuinely new frontend *logic* rather than relocating existing logic — that
  phase should add the harness to cover its own new behaviour, not retroactively for this
  one, which is verified against a byte-identical baseline (§5).
- **Deleting the `mockFetch` / `?state=` scaffolding** (§2). Phase 1 mockup machinery that
  still works. **Trigger:** when someone decides the real backend's error and empty states
  can be exercised another way in development; until then it is moved unchanged, not
  removed, because deletion is a behaviour change and this phase makes none.
- **Splitting `styles.css`** (Fork D). **Trigger:** the stylesheet growing past the point
  where one banner-sectioned file is navigable. 284 lines is not that point.
- **Any change to `serve.js`.** It serves the module graph unchanged (§1); giving it
  features (caching headers, a manifest, gzip) is a deployment concern gated behind the
  same trigger as the bundler.
- **TypeScript on the frontend.** The backend is TypeScript; the frontend is deliberately
  plain JS with no compile step, and adding one is Fork A2 wearing a different hat. Not
  now, and not as a rider.
- **Renaming routes, restyling screens, or consolidating the sixteen views' duplicated
  list/detail/form patterns.** Every one is a behaviour or appearance change. This phase
  relocates; it does not improve. A CSS tidy or a shared-list-component extraction is a
  legitimate *later* phase, made easier by this one, and explicitly not smuggled into it.

---

## 8. Definition of done

- [ ] `frontend/index.html` is a shell of roughly thirty lines: the fonts `<link>`, a
      `<link rel="stylesheet" href="styles.css">`, the root mount element, and one
      `<script type="module" src="main.js">` — and nothing else.
- [ ] The 284-line stylesheet lives in `styles.css`, extracted verbatim (Fork D); the app
      renders pixel-identically to the pre-split baseline.
- [ ] The JavaScript is a graph of ES modules (`config`, `session`, `reference-data`, `ui`,
      `api`, `router`, `main`, and the `views/` group per Fork C), each with one concern,
      `import`/`export` at every boundary, no shared implicit globals.
- [ ] **No framework, no bundler, no build step, no new npm dependency, no new config
      file** was added (Fork A1). `package.json` for the frontend is still absent or
      unchanged; there is no `node_modules` under `frontend/`.
- [ ] **`serve.js` is byte-for-byte unchanged**, and `node serve.js` + `localhost:5173`
      runs the app exactly as before.
- [ ] Shared mutable state (`CURRENT_USER`, `CATEGORIES`) lives in dedicated modules with
      accessor functions (Fork B); **no module reassigns an imported binding**, proven by
      a deliberate reintroduction of that pattern failing to load with a console error.
- [ ] The inline-handler grep (`on*=` in any `frontend/**/*.js`) is **zero**, as it was
      before the split.
- [ ] The browser console is **clean** — no uncaught error, syntax error, or failed module
      fetch — on every one of the sixteen views.
- [ ] The full smoke walk (§5) passes for **both** roles against the pre-split baseline:
      login/logout, dashboard, all product/supplier/category/user screens with their
      role-gated buttons, the transaction wizard including Phase 12's dual outcome, global
      history, audit, approvals, the account screen, and the `?state=error`/`empty`
      overrides — every screen behaving identically to before.
- [ ] **No domain document changed:** `product.md`, `requirements.md`, `business-rules.md`,
      `domain-model.md`, and `api.md` are untouched — no new FR, BR, entity, route, or
      response. Confirmed by inspection, and their absence from §4 is deliberate.
- [ ] `architecture-observations.md` records the frontend's first structural phase — the
      mockup-that-became-the-product, native modules over a bundler on `serve.js`'s own
      grounds (with the deploy-time trigger), and the frontend now decomposing by the same
      resources as the backend.
- [ ] `README.md`'s layout and current-phase sections reflect the split, and state
      explicitly that **running the frontend did not change.**
- [ ] Every fork was decided and recorded either way: split at all (Fork 0), the mechanism
      (Fork A, with A2 and A3 rejected on stated grounds and A2's trigger named), the
      shared-state pattern (Fork B), view granularity (Fork C), and the stylesheet (Fork D).
- [ ] No extraction step shared a commit with a behaviour change; the phase is provable as
      a pure refactor because every step was one.
