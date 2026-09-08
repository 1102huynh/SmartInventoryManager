# Phase 25 Plan — Promote `no-floating-promises` and `no-unsafe-argument` from `warn` to `error`

Status: Phase 25 — Complete (one two-line config change + docs; the call-site set the
promotion was deferred against was measured and is empty)
Last updated: 2026-09-08
Scope decided with the project owner: **flip
`@typescript-eslint/no-floating-promises` and `@typescript-eslint/no-unsafe-argument`
from `warn` to `error` in `backend/eslint.config.mjs`, having first confirmed the
committed tree already passes both** — so the two rules `recommendedTypeChecked` ships as
errors stop being the only two the project runs at a lower severity, and a future
violation of either lands as a build failure instead of a line that scrolls past. This is
issue #15, and it is the follow-up Phase 16 §7 named by hand ("Promoting
`no-floating-promises` and `no-unsafe-argument` from `warn` to `error` … a separate
decision about rule strictness [that] would surface its own set of call sites to fix").

Scoped the same way every phase in this series has been: one headline change, an explicit
out-of-scope list, no punch-list riding along. Like Phase 24, this phase ships **no
application code and no migration** — the deliverable is a severity change in the lint
config and the measurement that shows it costs nothing. Unlike Phase 16, there is **no
`eslint --fix` sweep and no call site to fix**, because the set Phase 16 §7 predicted the
promotion "would surface" was measured for this phase and turned out to be empty.

## Why this phase, why now

`backend/eslint.config.mjs` has run exactly two rules below their
`recommendedTypeChecked` default since Phase 16:

```js
'@typescript-eslint/no-floating-promises': 'warn',   // recommendedTypeChecked ships 'error'
'@typescript-eslint/no-unsafe-argument': 'warn',     // recommendedTypeChecked ships 'error'
```

Phase 16's job was to get the tree to exit `0` against the rules **as configured that
day** and make the CI `lint` step blocking; it explicitly declined to also tighten these
two, on the reasoning that doing so "would surface its own set of call sites to fix" and
was a separate decision. That was the right call for Phase 16 — bundling a
rule-strictness change into the phase that made lint blocking would have mixed a
judgement call in with a mechanical cleanup.

**The trigger.** Phase 16 made `lint:check` a required check on `develop` (issue #6). A
rule at `warn` in a blocking-on-`error` pipeline is the worst of both configurations: it
runs the full type-aware analysis on every push (so it costs what `error` costs), prints
the finding, and then lets the build go green anyway. `no-floating-promises` in
particular is not a style preference — it catches a genuine class of bug (an un-awaited
async call whose rejection becomes an unhandled promise rejection, or whose ordering
silently doesn't hold), and this backend already has three deliberate fire-and-forget
sites (`void bootstrap()` in `main.ts`, and the two `void this.…().catch(…)` background
sweeps in `AuditService` and `PostgresThrottlerStorage`) that are written to the
`void`-the-promise idiom the rule enforces. The rule is already shaping how the code is
written; running it at `warn` just means the one day someone forgets the `void`, CI
won't say so.

**Why now specifically, and not "fold it into the next backend phase":** the same
argument Phase 24 made for discharging a standing §7 conditional with evidence once the
thing it is conditioned on is cheap to check. Phase 16 §7 conditioned this on "its own
set of call sites to fix." That set is a `git`-clean `npm run lint:check` away from being
counted. It was counted (§1); it is empty; so the promotion is a two-line diff with no
code change, and leaving it as a perpetual §7 line costs more attention over time than
spending a short phase to close it.

**This phase changes no domain document** — no new FR, no new BR, no entity, no route, no
query parameter, no migration, no schema change. The files that change are
`backend/eslint.config.mjs` (the two severities, plus a comment pointing here),
`docs/phase-25-plan.md` (this file), `docs/architecture-observations.md` (a Phase 25
addition to the Phase 15/16 CI section), and the standing "no new FR / no new BR" notes
in `requirements.md` / `business-rules.md`, plus the phase pointers in `README.md`,
`product.md` §11, and `api.md`'s title line.

---

## 1. The change, and the measurement that it costs no code

### The config diff

`backend/eslint.config.mjs`, the project-wide `rules` block:

```diff
     '@typescript-eslint/no-explicit-any': 'off',
-    '@typescript-eslint/no-floating-promises': 'warn',
-    '@typescript-eslint/no-unsafe-argument': 'warn',
+    // Phase 25 (docs/phase-25-plan.md, issue #15): both promoted from `warn` to
+    // `error`. …
+    '@typescript-eslint/no-floating-promises': 'error',
+    '@typescript-eslint/no-unsafe-argument': 'error',
     "prettier/prettier": ["error", { endOfLine: "auto" }],
```

The `files: ['**/*.spec.ts', 'test/**/*.ts']` override is **untouched** — it already
sets `no-unsafe-argument: 'off'` for test files (Phase 16's rationale: a mocked
repository or a `res.body` read from supertest crosses an untyped boundary on purpose),
and that stays true. The promotion tightens `no-unsafe-argument` from `warn` to `error`
only where it was already on, i.e. in `src/`. `no-floating-promises` has no override and
applies everywhere at `error` after this change.

### The measurement — the "set of call sites to fix" is empty

`npm run lint:check` (`eslint` with no `--fix`) on the committed tree, **before** this
change, reports **0 errors and 0 warnings** — for these two rules and for every other.
The tree is clean at `warn`, which means it is clean at `error`: flipping the severity
surfaces nothing to fix.

Cross-checks that this is a real pass and not the rules being silently inert:

- **`grep -rn "eslint-disable" src test`** — no `eslint-disable` / `-disable-next-line` /
  `-disable-line` comment anywhere in the backend. Nothing is being suppressed inline.
- **The three deliberate fire-and-forget sites already use `void`** — `src/main.ts:71`
  (`void bootstrap()`), `src/audit/audit.service.ts:106`
  (`void this.pruneToRetentionWindow().catch((err: unknown) => …)`), and
  `src/throttler/postgres-throttler.storage.ts:95`
  (`void this.sweep().catch((err: unknown) => …)`). These are exactly the shape
  `no-floating-promises` accepts, and they were written that way while the rule was at
  `warn` — evidence the rule has been shaping the code regardless of severity.
- **Enforcement probe.** A throwaway `src/__lint_probe__.ts` containing an un-`void`ed
  call to an `async` function reports
  `error  Promises must be awaited … @typescript-eslint/no-floating-promises` under the
  post-change config — so `error` genuinely blocks, and the clean run above is a real
  pass rather than a rule that isn't wired to the type-checker. (Probe file deleted; it
  was never committed.)

### Why the set is empty now when Phase 16 §7 expected one

Phase 16 §7 was written in early Phase 16, before that phase's own `--fix` sweep and
manual fixes landed, and it estimated the promotion "would surface its own set of call
sites." Between then and now, nine phases (17–24) of backend work were written under a
lint config where both rules ran at `warn` and printed on every local `npm run lint`.
A printed `warn` on the exact line you just wrote is visible; the code was kept clean of
both as it went. The promotion is catching up the config to a discipline the code
already follows — which is the cheapest possible time to make a rule stricter.

### Fork A — "leave them at `warn`; a warning is enough of a signal." Rejected.

`npm run lint` locally is still `eslint --fix`, and `--fix` output scrolls; a `warn` on a
fire-and-forget bug in a 30-file lint run is precisely the thing Phase 16's
"`--fix` silently rewrites and the residual errors scroll past" paragraph was about. In a
pipeline where `lint:check` is a required check that blocks on `error`, a `warn` is a
finding the gate is configured to ignore. Either the rule is worth running — in which
case a violation should stop the build, like every other rule here — or it isn't, in
which case it should be `off` and not cost analysis time. `warn` is the state that costs
the analysis and buys none of the enforcement.

### Fork B — also promote the other `unsafe-*` siblings, or `no-explicit-any`. Out of scope.

`no-explicit-any` is `off` **project-wide and on purpose** (the DTO/entity layer leans on
`any` at a few typed-boundary points); turning it on is a much larger call-site question
and a different decision. The four `unsafe-*` siblings
(`no-unsafe-assignment/-member-access/-return/-call`) are already at their
`recommendedTypeChecked` `error` severity in `src/` — they are only relaxed in the
test-file override, which Phase 16 justified and this phase does not reopen. There is
nothing to promote there. This phase is exactly the two rules issue #15 and Phase 16 §7
name.

### What would reopen this

Nothing routine. If a future phase deliberately introduces a pattern that one of these
rules can't see is safe (a genuine typed-boundary `unsafe-argument`, say), the fix is a
scoped `eslint-disable-next-line` with a comment — the same escape hatch every other
`error` rule here already has — not a return to `warn`.

---

## 2. What's new (backend)

**No dependency, no migration, no entity change, no service change, no DTO change, no
runtime code touched at all.** The only backend file that changes is
`backend/eslint.config.mjs`, and only its two rule severities (plus a comment). The three
DB registries (`database.module.ts`, `data-source.ts`, `test-data-source.ts`) are
untouched — stated because the schema-touching phases in this series each carry a line
about them, and this phase has nothing to say there.

## 3. Frontend changes

**None.** The frontend is plain JS with no lint toolchain by design (Phase 13); this
config is `backend/`-only. No `frontend/` file changes; the `node --test` suite is not
touched.

## 4. Documentation updates

1. **`docs/phase-25-plan.md`** — this file: the change, the measurement showing it costs
   no code, the enforcement probe.
2. **`docs/architecture-observations.md`** — a Phase 25 addition to the "continuous
   integration, and the preconditions it made explicit" section (the same section Phase
   16 extended): the two rules `recommendedTypeChecked` ships as errors ran at `warn`
   from Phase 16 to Phase 25 as a deliberate deferral; the promotion was gated on a
   call-site count that came back empty; the tree was already written to the
   `void`-the-promise idiom. Records that, like Phase 24, this phase's deliverable is a
   decision plus a two-line change, not a feature.
3. **`requirements.md`** — a "Lint Rule Strictness (Phase 25 — no new FR, no schema
   change)" note beside the Phase 20–24 ones: no FR reads differently; there is no
   migration and no schema change; the deliverable is the severity change and the
   measurement that it needs no code fix.
4. **`business-rules.md`** — a "**[2026-09-08, Phase 25]** No new BR" line: how strictly
   the build checks its own async-call hygiene is an engineering-practice fact, never a
   rule about the business — the same reason the Phase 15 CI pipeline and the Phase 16
   lint gate each filed a "no new BR" line (or none at all).
5. **`README.md`** — Current phase to Phase 25; Phase 24 moves to "Earlier phases". The
   entry notes there is no migration to run and no application-behaviour change. The
   "Continuous integration" section's `lint` bullet gets a half-sentence: `no-floating-promises`
   and `no-unsafe-argument` now `error`, like every other rule the job enforces.
6. **`product.md` §11** — a Phase 25 cross-reference entry in the "no scope change" shape
   (same as the Phase 15 and Phase 16 engineering-practice entries): no new user goal, no
   use case, no §7 scope; issue #15 / Phase 16 §7 named; Q-4 was resolved in Phase 18 and
   Q-7 (multi-location) remains open, untouched since Phase 5.
7. **`api.md`** — title and status line bumped to Phase 25 with an explicit "no API
   change"; no route, response, or parameter text changes.

## 5. Testing plan

**No new tests.** There is no runtime code to pin. The lint config is not on any
`jest` / `nest start` code path — promoting a rule's severity cannot change a test
result, a response, or a migration. Verification for this phase is:

- **`npm run lint:check` exits `0`** under the post-change config — run, confirmed (§1).
- **`npx nest build` exits `0`** (the CI `lint` job's typecheck half) — run, confirmed.
- **The enforcement probe** (§1) shows `error` blocks and the clean run is a real pass.
- **The DB-backed suites** (`npm test`, `npm run test:e2e`) are **unaffected by
  construction** and are the CI `test` / `e2e` jobs' responsibility on the PR. They were
  not run in this worktree — it is a fresh checkout with no portable Postgres and no
  `.env` — which is acceptable *only* because this phase changes no code those suites
  exercise. If either goes red on CI it has found something this phase did not cause.

## 6. Rollout order

One step: land the config change and the documentation together. Nothing to stage,
nothing to de-risk — the change is inert until the next lint run, and the next lint run
is already green.

## 7. Explicitly out of scope for Phase 25 (Future)

- **Promoting `no-explicit-any` from `off`** — a genuinely larger call-site question
  (the DTO/entity layer uses `any` at typed boundaries on purpose), a separate
  rule-strictness decision, and not what issue #15 asks. Fork B.
- **Narrowing the test-file `unsafe-*` override** — Phase 16 justified relaxing
  `no-unsafe-assignment/-member-access/-return/-argument/-call` for `**/*.spec.ts` and
  `test/**/*.ts` (a mocked repo or a supertest `res.body` is `any` by the nature of the
  boundary). This phase does not reopen that; a typed test-fixture layer is its own piece
  of work with no current driver.
- **Pre-commit hooks (husky / lint-staged)** — Phase 16 §7's Fork G, unchanged.
  **Trigger:** lint/prettier drift recurs despite the blocking CI check.
- **A frontend lint or typecheck** — the frontend has no toolchain by design (Phase 13);
  same trigger as Phase 13 §7's frontend-build-step line.
- **Coverage reporting / a coverage gate** — as Phase 15 §7 and Phase 16 §7. Unchanged.
- **Bringing `docs/learning-notes/` current** — frozen at Phase 8; named in Phase 15 §7
  as its own focused work, still not this phase's problem.
- **Q-4 follow-ons and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] `backend/eslint.config.mjs` sets `@typescript-eslint/no-floating-promises` and
      `@typescript-eslint/no-unsafe-argument` to `'error'` (was `'warn'`), with a comment
      pointing at this plan and issue #15.
- [x] The test-file override (`files: ['**/*.spec.ts', 'test/**/*.ts']`) is unchanged —
      `no-unsafe-argument` stays `off` there for the reason Phase 16 recorded.
- [x] `npm run lint:check` exits `0` on the committed tree under the new config — the
      "set of call sites to fix" Phase 16 §7 anticipated was measured and is **empty**
      (no `eslint-disable` anywhere; the three fire-and-forget sites already use `void`).
- [x] Enforcement confirmed: an un-`void`ed async call reports
      `@typescript-eslint/no-floating-promises` as an `error` under the new config.
- [x] `npx nest build` exits `0` (the `lint` job's typecheck half).
- [x] No migration, no schema change, no entity/service/DTO change, no `frontend/`
      change, no domain-document change; the three DB registries untouched.
- [x] `architecture-observations.md` Phase 25 addition to the CI section;
      `requirements.md` and `business-rules.md` standing notes; `README.md`,
      `product.md` §11, and `api.md` phase pointers all updated.
- [x] The DB-backed backend suites are unchanged by construction and left to the CI
      `test` / `e2e` jobs on the PR (this worktree has no Postgres); noted in §5.
