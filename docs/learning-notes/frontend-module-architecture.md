# Frontend Module Architecture (Native ES Modules)

*The first learning note about the frontend — every other file in this folder explains
a NestJS concept against the backend. Phase 13 (`docs/phase-13-plan.md`) was the first
phase that was *about* the frontend itself; its §4 made this note optional and put the
structural account in `architecture-observations.md` ("the frontend's first structural
phase"). It is written now (issue #5) because the ES-module mechanics below — the
live-binding trap in particular — are a lesson that has nothing to do with NestJS and
belongs in the register anyway.*

## Concept

`frontend/` is plain browser JavaScript: no framework, no bundler, no build step, no
`node_modules`. Until Phase 13 it was also a single 3,061-line `index.html` — a
284-line `<style>` block and one `<script>` holding a config layer, an `Auth` helper,
the `Store` API client, the `UI` helpers, a hash router, and sixteen `Views.*`
screen-render functions. Phase 13 split that into `styles.css` plus a graph of ES
module `.js` files, served by the existing `serve.js` with no change to it. "ES module"
here means the browser's own `import`/`export`, loaded through one
`<script type="module" src="main.js">` — a browser feature, not a tool.

## Why split it, and why only now

Two different facts about the same file:

- **One file was *right* in Phase 1.** `index.html` was a navigable mockup built to
  validate workflows against `product.md` before any server existed. A throwaway that
  exists to be thrown away is one file, correctly.
- **It stopped being right silently.** It was never rewritten; instead every backend
  phase that touched the UI (3, 5, 6, 9, 11, 12) reached in and added a screen or a
  gate, and the mockup became the product without anyone deciding it should.

The project noticed the second fact only when a phase was finally about the frontend.
The generalizable point: *"this was the right call"* and *"this is still the right
call"* are separate questions, and a structure nobody is looking at goes unquestioned
no matter how far it has drifted from the conditions that justified it.

## Native ES modules, not a bundler

Fork A (`docs/phase-13-plan.md` §1). The split uses the browser's native
`import`/`export`. A bundler (Vite / esbuild) was rejected on `serve.js`'s own stated
grounds: `serve.js` exists precisely because the frontend needs a real HTTP origin but
*not* a toolchain — its comment says it is "just enough to serve `index.html` over
HTTP." A bundler would delete that reason to exist and add back the build step,
dependency tree, and config surface it was written to avoid, all to solve a problem
(module loading) that browsers solved natively.

The one thing a bundler buys that native modules do not is collapsing many files into
one HTTP request. On `localhost:5173` against a `localhost` API that is imperceptible.
It becomes real only if this frontend is ever deployed to real users over a real
network where the per-file request waterfall measurably hurts first paint — and *that*
is the concrete trigger (§7) to add a bundler then, as a deployment-time optimisation
of an already-modular codebase. Splitting into modules now makes a future bundler
*easier*, not redundant. The shape of the decision: pay for an abstraction at the
moment it starts earning its keep, on the evidence, not ahead of it.

## The live-binding trap: an imported binding is read-only

This is the one place the single-file design was doing something that does not survive
the split unchanged, and the failure is easy to mispredict.

Two pieces of state were module-level `let`s that one function mutated and another
read: the current user (`session.js` — set by `Store.login`, cleared by `Store.logout`,
read by the router and several views) and the categories reference-data cache
(`reference-data.js` — filled once after login, read synchronously on every render). In
one lexical scope, `let currentUser = null` written by one function and read by another
Just Works.

Across ES modules it does not. **An imported binding is a live, *read-only* view of the
exporter's variable.** `import { currentUser } from './session.js'` always sees the
latest value — but `currentUser = x` in the importing module is a *compile error*: you
cannot reassign another module's export. So the naive split — move the `let` to a
shared module, import it everywhere — compiles for every reader and breaks for the two
writers. It breaks loudly (a `SyntaxError`), which is the good kind of failure, but
only if you knew to expect it.

The fix in `session.js` / `reference-data.js` is **accessor functions**, not a shared
mutable object:

```js
let currentUser = null;
let accessToken = null;
export function getCurrentUser(){ return currentUser; }
export function setCurrentUser(user){ currentUser = user; }
export function clearSession(){ currentUser = null; accessToken = null; }
```

Exporting a single mutable object instead (`export const session = { user: null }`,
everyone reading and writing `session.user`) would also work — object *properties* are
mutable across modules even though the binding is not — and it is fewer lines. It is
rejected because it re-creates the exact thing the split removes: unrestricted mutation
of shared state from anywhere, now invisible across a file boundary instead of visible
within one scope. An accessor makes "who is allowed to change the current user"
greppable — it is the callers of `setCurrentUser`, and there are two (`Store.login`,
`Store.logout`). This is the same reasoning BR-082 uses to keep `actor` and `subject`
as two explicit columns rather than one clever one (`docs/learning-notes/cross-cutting-concerns.md`,
`docs/learning-notes/authentication-and-guards.md`): the explicit form answers the
question the implicit form makes you reconstruct.

## The `import` *is* the registry

The single-file app had a `Views = {}` object that every screen function attached
itself to, and the router dispatched through it. Phase 13 dropped it: `router.js` now
does `import { productList, productDetail, productForm } from './views/products.js'`
and calls those names directly from its `renderApp` dispatch. In a module world the
import list *is* the registry — the router's dependency on each view is explicit and
greppable, and it is one less piece of shared mutable namespace. A registry object was
a single-file convenience; it has nothing to add once every reference is already an
`import`.

## Group view files by resource, not by view

Fork C. The sixteen render functions became roughly nine files grouped by the domain
resource they serve: `views/products.js` is list + detail + form, `views/suppliers.js`
the same, `views/transactions.js` the wizard + global history, and so on. Each file
maps to a nav section and — not by accident — to a backend module (`ProductsModule`,
`SuppliersModule`, `AdjustmentsModule`…). A reader who knows the backend's shape
already knows where a screen lives. One file per view was rejected as the frontend
equivalent of a per-method file — an over-abstraction this project routinely declines.
The decomposition deliberately mirrors the one the backend already committed to, so
both halves of the app share one map.

## What made the split safe

The "no behaviour change" claim rested on three properties of the pre-split file:

- **Zero inline `on*=` handlers.** Every event binding goes through `addEventListener`
  inside a view's `attach()` function. The classic ES-module regression — an
  `onclick="doThing()"` inside a template string that silently stops resolving once
  `doThing` is no longer a global — *cannot* occur here because there are none. (§5
  re-asserts this with a grep that must stay at zero.)
- **Every `window.*` use is a genuine browser API** — `window.API_BASE` (config
  override), `window.scrollTo`, and two `window.addEventListener` calls (`hashchange`,
  `DOMContentLoaded`) — not an implicit global the split would strand.
- **The namespaces were already clean seams.** `Auth`, `Store`, `UI`, `Views`, the
  router, and the config layer were already distinct objects referencing each other by
  name; the split turned each name-reference into an `import`. It did not have to
  *find* the boundaries — the Phase 1 author had drawn them, just all in one file.

`serve.js` needed **no change**: it already serves `.js` / `.css` with correct MIME
types and resolves nested paths (`path.join(ROOT, …)` plus its `../` guard), so it
serves `/views/products.js` unmodified. Static files are static files.

## Runtime-only import cycles are fine

`router.js` imports `api.js` and every view; `api.js` imports back to `router.js`
(`renderApp`, for the one case where the hash is already `#/login`); views import
`api.js`. These cycles look alarming and are harmless: ES modules resolve a cycle as
long as no module *calls into* another at **evaluation time** — i.e. at the top level
of the file, while it is still being defined. Every call site in these cycles is inside
a function that runs later, after all modules have finished evaluating. A cycle that
only closes at runtime is not something to design away.

## Common Mistakes

- Moving a shared `let` into a module and importing it, expecting writers to keep
  reassigning it — readers compile, writers get a `SyntaxError`. Use accessors.
- "Fixing" that by exporting a mutable object and writing through its properties — it
  compiles, and it throws away the one thing the split was for: a greppable answer to
  "who changes this?"
- Reaching for a bundler because "nine files means nine requests" — true, and it costs
  nothing on `localhost`; add the bundler when there is a real network in the picture,
  not before.
- One file per view "for isolation" — nine resource-grouped files that mirror the
  backend modules are easier to navigate than sixteen that map to nothing.
- Trying to break an import cycle that only closes inside a function call — ES modules
  already handle that case.

## Key Takeaways

- The frontend is a native-ES-module graph — no framework, no bundler, no build —
  split out of one file in Phase 13; `serve.js` serves it unchanged.
- "It was the right call" and "it is still the right call" are different questions; a
  structure nobody audits drifts unquestioned. One file was right as a mockup and
  wrong as a 3,000-line app.
- An imported binding is a live, *read-only* view — you cannot reassign another
  module's export. Shared mutable state crosses a module boundary through accessor
  functions, not a reassigned import and not a mutable object.
- Accessors over a shared object because "who is allowed to write this" should be one
  greppable list — the same discipline as naming two facts with two columns.
- The router's import list is the view registry; a registry object adds nothing once
  every reference is an `import`.
- Group view files by resource, mirroring the backend modules — not one file per view.
- Runtime-only import cycles are fine; only an evaluation-time call across the cycle is
  a problem.
- Add a bundler when the code is deployed over a real network and the request waterfall
  measurably hurts — as an optimisation of an already-modular codebase, which is the
  state Phase 13 leaves it in.

---

*Phase 14 (`docs/phase-14-plan.md`) added `frontend/test/` — the first frontend tests
— when it added the first genuinely new frontend logic (the list-screen pager),
exactly as Phase 13 §7 said that trigger would fire. See
`docs/learning-notes/testing-strategy.md`.*
