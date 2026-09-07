# Phase 16 Plan — A Clean, Blocking Lint

Status: Phase 16 — Implemented on branch `phase-16` (all steps done and verified
locally; first hosted CI run pending a `git push`)
Last updated: 2026-09-07

**[2026-09-07, on implementation]**
- **The `--fix` sweep was not purely subtractive.** Removing the two
  `no-unnecessary-type-assertion` casts (`as User` in `jwt.strategy.spec.ts`) orphaned
  that file's `import { User }`, turning the pre-fix "5 manual errors" into 6: 4
  `no-unsafe-call` + 2 unused (`jwtService` in `users.e2e-spec.ts`, now-unused `User`
  import). Both unused symbols deleted; the `no-unsafe-call` four handled by Fork B.
- **Fork C confirmed.** `jwtService` was `moduleRef.get(JwtService)` in `beforeAll`
  and never read — dead setup; nothing in the `describe` needed it (e2e tokens come
  from real `/auth/login`). Removed import, field, and assignment.
- **Fork B scoping verified (§5).** A deliberate `x.foo()` on `any` in a throwaway
  `src/` file still errors `no-unsafe-call` — the relaxation is confined to
  `**/*.spec.ts` + `test/**/*.ts`.
- **Fork F: `git add --renormalize .` produced no content diff** — blobs were already
  LF. `.gitattributes` is for future determinism and to match the Linux runner.
- **Verification (portable Postgres running):** `npm run lint:check` exits `0`;
  `npm test` 14 suites / 143 tests; `npm run test:e2e` 7 suites / 90 tests — all green,
  counts unchanged from Phase 15's baseline. The `--fix` diff was read hunk by hunk:
  wrapping, trailing commas, and two removed redundant `as` — nothing else. The CI
  negative check (reintroduce an error → red) is pending the push.

Scope decided with the project owner: **get `eslint` to exit `0` on the backend tree,
give CI a `--fix`-free way to run it, and flip the `lint` job's eslint step from
informational to blocking — so the check Phase 15 wired stops being permanently
yellow** — and nothing else. Scoped the same way `phase-13-plan.md` was scoped to the
frontend split and `phase-15-plan.md` to the CI pipeline: one headline change, an
explicit out-of-scope list, no punch-list riding along.

This phase is **the second half of Phase 15**, in the manner of Phase 6 finishing what
Phase 5 started. Phase 15 (`docs/phase-15-plan.md`) built the pipeline and, in §7,
named this exact follow-up:

> **A proper lint gate.** `npm run lint` is `eslint --fix` (mutates, does not check)
> and the committed tree has [errors] it cannot auto-fix … Making lint a real,
> blocking check means a check-mode script (`eslint` without `--fix`) *and* clearing
> those errors … **Trigger:** its own small `chore:` change, ideally before CI is made
> a required check.

**Assumes Phase 15 has merged to `develop`.** This phase edits
`.github/workflows/ci.yml` and `backend/package.json`, both introduced/last-touched by
Phase 15. If Phase 15 is still on its branch when this is implemented, rebase this onto
it rather than onto bare `develop`.

## Why this phase, why now

Phase 15's `lint` job runs `npm run lint` with `continue-on-error: true` — it reports,
it does not gate. That was the honest call at the time (clearing the tree touches
`src/` and `test/`, which Phase 15's scope forbade), but it leaves the pipeline with a
step that is **designed to be ignored**. A check nobody has to pass is a check that
rots: the next real lint regression lands the same colour as today's pre-existing
noise, and nobody looks.

**The accurate census** (Phase 15's amendment said "6 errors plus ~12 non-prettier-clean
files" — that count was taken mid-`--fix` and undershot). A check-mode run,
`npx eslint "{src,apps,libs,test}/**/*.ts"` on the committed tree:

| | count | fixable by `--fix`? |
|---|---|---|
| `prettier/prettier` (line-wrapping, trailing commas, multi-line params/imports) | 22, across ~13 files | yes |
| `@typescript-eslint/no-unnecessary-type-assertion` (`jwt.strategy.spec.ts`) | 2 | yes |
| `@typescript-eslint/no-unsafe-call` (`audit.e2e-spec.ts`, `users.e2e-spec.ts`) | 4 | no |
| `@typescript-eslint/no-unused-vars` (`jwtService` in `users.e2e-spec.ts`) | 1 | no |
| **total** | **29** | **24 yes / 5 no** |

So the work is: one `--fix` sweep (24), one config line (the 4 `no-unsafe-call`), one
deleted variable (1). Then flip the switch. **Why now:** it is small, it is
pre-authorised by Phase 15 §7, and every day it waits the "informational" lint step
trains the one contributor to not read it.

**This phase changes no domain document and no application behaviour.** No new FR
(a lint gate is not a user goal), no new BR, no entity, no route, no migration. The
`src/`/`test/` edits are formatting, one relaxed test-only rule, and one dead-variable
deletion — proven inert by the suite staying green (§5). The documents that change are
`README.md`, `backend/README.md`, `docs/architecture-observations.md`, and a dated
amendment to `docs/phase-15-plan.md` — plus the "no new FR/BR" notes Phases 10, 11, 12,
and 15 each left.

---

## 1. Design decisions

### Fork A — the 24 auto-fixable errors. Recommended: one mechanical `eslint --fix` sweep, committed alone

- **A1 — run `npx eslint "{src,apps,libs,test}/**/*.ts" --fix` once, commit the result
  as its own `style:` commit** so the diff reviews as "formatting only" and never
  shares a commit with a behaviour change (the same rule Phase 12 and Phase 13 applied
  to their refactors). The 22 `prettier/prettier` fixes are whitespace, trailing
  commas, and multi-line wrapping; the 2 `no-unnecessary-type-assertion` fixes remove a
  redundant `as` the compiler already knew. **Recommended.**
- **A2 — hand-format the 13 files.** Pointless and error-prone against a tool that does
  it deterministically.
- **A3 — downgrade `prettier/prettier` to `warn`.** Rejected: it hides formatting
  drift permanently and makes the "blocking lint" this phase exists to deliver a lie
  for the largest rule.

### Fork B — the 4 `no-unsafe-call` errors in the e2e specs. Recommended: relax the rule in the existing test-file override

`eslint.config.mjs` already carries this block:

```js
{
  // Test files routinely cross an untyped boundary on purpose — a mocked
  // repository … or an HTTP response body read via supertest … is `any` by
  // nature, not a sign of a bug the way the same pattern would be in application
  // code. Relaxing the unsafe-* rules only here keeps them meaningful everywhere else.
  files: ['**/*.spec.ts', 'test/**/*.ts'],
  rules: {
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
  },
}
```

The 4 errors are `res.body.<something>()`-shaped calls on a supertest response body —
**the same untyped boundary the block's comment is about**, and `no-unsafe-call` is
the one `unsafe-*` sibling it forgot to list.

- **B1 — add `'@typescript-eslint/no-unsafe-call': 'off'` to that block.** One line,
  consistent with its four siblings and its own stated rationale. **Recommended.**
- **B2 — cast each call site** (`(res.body as AuditListResponse).forEach(...)`).
  Rejected: it invents response-shape types that exist nowhere else, for test-only
  code, and adds noise at four sites to avoid one config line.
- **B3 — `// eslint-disable-next-line` at each site.** Rejected: five scattered
  suppressions with no shared explanation, versus one rule decision with a comment
  already written.

### Fork C — the unused `jwtService` in `users.e2e-spec.ts:38`. Recommended: delete it, after confirming it is genuinely dead

`const jwtService = app.get(JwtService)` (line ~38) is assigned and never read. Almost
certainly leftover setup from a test that was rewritten.

- **C1 — delete the binding and its `JwtService` import if that leaves it unused.**
  **Recommended**, *conditional on* a read of the surrounding `describe` confirming no
  test was meant to use it (e.g. a half-written "token is signed with the configured
  secret" assertion). If such a test is missing, that is a coverage gap to record in
  the plan's §5 notes — not something to paper over by deleting the handle.
- **C2 — prefix with `_` / add to an ignore pattern.** Rejected: keeps dead code and
  its import for no reason.

### Fork D — the CI `lint` job. Recommended: remove `continue-on-error`, keep `nest build` as the second blocking step

Once the tree is clean (A–C), the eslint step has no reason to be advisory.

- **D1 — drop `continue-on-error: true` from the eslint step; leave the `nest build`
  step as-is.** The job now fails on any eslint error — a real regression gate. The
  job comment in `ci.yml` (currently a paragraph explaining why lint is informational)
  shrinks to one line. **Recommended.**
- **D2 — keep it informational, just with fewer errors.** Rejected: that is this
  phase declining to happen.

### Fork E — how CI runs eslint. Recommended: a new `lint:check` script; leave `lint` as `--fix` for local use

`npm run lint` is `eslint … --fix`: it *rewrites* files. In CI that is pointless
(the checkout is thrown away) and, on any dirty tree, it "fixes" and then still exits
non-zero — a confusing signal.

- **E1 — add `"lint:check": "eslint \"{src,apps,libs,test}/**/*.ts\""` (no `--fix`);
  `ci.yml` runs `npm run lint:check`. `lint` stays `--fix` for the local
  fix-on-save habit.** One new script, zero disruption to muscle memory, and the
  README records the asymmetry (devs auto-fix; CI checks). **Recommended.**
- **E2 — change `lint` to check-mode, add `lint:fix`.** Rejected: silently changes
  what a command every contributor has typed for fifteen phases does.
- **E3 — inline `npx eslint …` in `ci.yml`.** Rejected: puts the lint glob in two
  places (the script and the workflow) that can drift.

### Fork F — line endings. Recommended: add a minimal `.gitattributes`

The census surfaced a real cross-machine ambiguity. `core.autocrlf=true` on the
author's Windows box means the working tree is CRLF while the committed blobs are LF;
`prettier`'s `endOfLine: "auto"` then accepts whichever a file currently has, so
`npm run lint --fix` locally flips endings back and forth and a lint run is not
deterministic across machines. CI's Linux checkout is already LF, so CI and local
disagree about what "clean" looks like at the byte level.

- **F1 — add `.gitattributes` with `* text=auto eol=lf` (plus explicit
  `*.ts text eol=lf` etc.), then `git add --renormalize .`.** Every checkout is LF
  regardless of `core.autocrlf`; a lint run is now deterministic and matches CI.
  Because the blobs are *already* LF, `--renormalize` should produce no content diff —
  if it does, that is the CRLF debt being paid once, explicitly, in its own commit.
  **Recommended** — it is cheap and the phase is about lint determinism.
- **F2 — set prettier `endOfLine: "lf"` and nothing else.** Fixes prettier's opinion
  but not the git working-tree churn or `--fix`'s ending flips.
- **F3 — leave it.** Then `npm run lint` keeps showing phantom `␍` diffs on Windows
  forever and "why does CI see different lint results than me" stays a live question.

### Fork G — drift prevention beyond CI. Recommended: none this phase

A pre-commit hook (`husky` + `lint-staged`) running `eslint --fix` on staged files
would stop drift at the source.

- **G1 — nothing; rely on the now-blocking CI check to catch drift on push.**
  **Recommended.** `husky` is a dependency, a `.husky/` directory, and a `prepare`
  script — real cost against the Phase 13/15 minimalism line, to pre-empt a problem CI
  now catches anyway.
- **G2 — add husky + lint-staged.** **Trigger:** lint/prettier drift actually recurs
  after this phase despite the blocking check. Not before.

---

## 2. What's new

No new dependency, no new module, no migration. One new file, one new script, a
one-line workflow change, and a bounded set of `src/`/`test/` edits that change no
behaviour.

| Change | Files |
|---|---|
| `.gitattributes` (Fork F) — `text=auto eol=lf` | new, repo root |
| `lint:check` script (Fork E) | `backend/package.json` |
| eslint step becomes blocking (Fork D) | `.github/workflows/ci.yml` — remove `continue-on-error: true`, trim the job comment |
| `no-unsafe-call: 'off'` in the test override (Fork B) | `backend/eslint.config.mjs` — one line |
| formatting sweep (Fork A) | ~13 backend `.ts` files — whitespace, trailing commas, wrapping; 2 redundant `as` removed |
| delete unused `jwtService` (Fork C) | `backend/test/users.e2e-spec.ts` — 1–2 lines |

### `run-seed.ts`, `data-source.ts`, every entity, `serve.js`, the frontend — untouched

The formatting sweep may touch two migration files (`1787470000000-…`,
`1787740000000-…`) for a `␍⏎ implements MigrationInterface` wrap — cosmetic, and the
migrations have already run everywhere, so `up()`/`down()` behaviour is unchanged and
no re-run is needed. `architecture-observations.md` records that a reviewer will see
migration files in a lint commit and that it is formatting only.

---

## 3. Frontend changes

**None.** The frontend has no eslint, no prettier, no `tsc` — deliberately (Phase 13,
`architecture-observations.md`). This phase is backend + CI + docs only. Phase 14's
Fork G would add a `frontend/` test job; that is still not shipped and is not this
phase's concern.

---

## 4. Documentation updates

1. **`docs/phase-15-plan.md`** — a dated amendment (house style — Phases 10 and 12
   amend earlier text in place): the "6 errors / ~12 files" figure in the
   implementation amendment is superseded by the accurate check-mode census (29 errors
   across ~15 files: 24 auto-fixable, 5 manual), and Phase 16 (`docs/phase-16-plan.md`)
   cleared them and made the `lint` job blocking. The §7 "A proper lint gate" bullet
   gets a "**Done — Phase 16**" prefix.
2. **`docs/architecture-observations.md`** — extend the Phase 15 cross-cutting section
   (not a new section — this is the same thread): the lint step went informational →
   blocking; what "clean" required (a formatting sweep; one `unsafe-*` sibling rule
   added to the test override on the rationale its four siblings already use; a
   `.gitattributes` so a lint run is byte-deterministic across a Windows dev box and a
   Linux runner). And: **branch protection is now genuinely one click** — the only
   real blocker (a permanently-red lint check) is gone. *(Flipped shortly after, by
   issue #6 — see §7; this line is the Phase 16 record.)*
3. **`README.md`** — the "Continuous integration" section: `lint` is now a blocking
   check (drop the "non-blocking informational" caveat); the badge should now be
   fully green. Add `.gitattributes` / line-ending normalisation as a one-liner under
   the CI or layout section.
4. **`backend/README.md`** — the "Other scripts" list: `lint` (`--fix`, local
   fix-on-save) and the new `lint:check` (no fix — what CI runs), one line each.
5. **`requirements.md`** — a sixth "no new FR" note beside Phases 7, 8, 10, 11, and 15.
   One line: a lint gate is an engineering practice, not a capability in `product.md`
   §4.
6. **`business-rules.md`** — a "no new BR" line, the fifth after Phases 10, 11, 12, and
   15. Lint enforces nothing about the business.
7. **`product.md` §11** — a Phase 16 cross-reference in the Phase 7/10/11/15 register:
   no user goal, no use case, no scope change. Q-4 and Q-7 untouched.
8. **`domain-model.md`, `api.md`** — **no change**, stated here because a reader
   checks. Nothing here is about an entity, a column, or a route.
9. **`docs/learning-notes/`** — **not touched.** It is frozen at Phase 8 and now eight
   phases behind (9–15). Phase 15 §7 named the catch-up as its own focused piece of
   work and this phase does not ride it along either — recorded again so the gap stays
   on the record.

---

## 5. Testing plan

The deliverable is "eslint exits 0 and the `lint` job blocks on it," so the risk to
manage is that a formatting tool touching ~15 files, plus one relaxed rule, changed
behaviour somewhere.

- **`npm run lint:check` (or `npx eslint "{src,apps,libs,test}/**/*.ts"`) exits `0`**
  on the final tree. This is the headline check.
- **The full backend suite stays green, unchanged in count**, after every step:
  `npm test` → 14 suites / 143 tests, `npm run test:e2e` → 7 suites / 90 tests (the
  numbers Phase 15's local verification established). A formatting sweep that changes a
  test outcome is not a formatting sweep. Run against the same `smart_inventory_test`
  and freshly-migrated `smart_inventory_e2e` Phase 15 documented.
- **Diff inspection of the Fork A commit** — every hunk is whitespace, wrapping, a
  trailing comma, or a removed `as`. Read it, do not just trust that `--fix` produced
  it. Any hunk that is not one of those is investigated.
- **The `no-unsafe-call` relaxation (Fork B) is scoped to `files: ['**/*.spec.ts',
  'test/**/*.ts']`** — confirm with `npx eslint src/some-service.ts` on an application
  file containing a deliberate `x.y()` on an `any` that the rule *still* fires there.
  The relaxation must not leak into `src/`.
- **The deleted `jwtService` (Fork C)** — `test/users.e2e-spec.ts` still compiles
  (`nest build` / `tsc`), the file's tests still pass, and the `describe` was read to
  confirm nothing intended to use it. If a test was clearly meant to and is missing,
  note it here as a follow-up rather than deleting silently.
- **CI negative check** — after the eslint step is blocking, push a branch that
  reintroduces one error (a stray `const x = 1;`), confirm the `lint` job goes **red**
  and the run fails, then revert. Proves the gate gates (the Phase 15 §5 pattern,
  applied to lint).
- **`.gitattributes` (Fork F)** — after adding it, `git add --renormalize .` produces
  **no content diff** (blobs were already LF). If it does, that diff is the one-time
  CRLF normalisation, committed alone with that explanation.
- No new `*.spec.ts`. This phase asserts nothing new about the code; it makes the
  existing assertions run under a lint the pipeline actually enforces.

---

## 6. Rollout order

Each step leaves `develop` building and the suite green.

1. **`.gitattributes` + `git add --renormalize .`.** Confirm no content diff. Commit
   alone (`chore: normalise line endings to LF via .gitattributes`).
2. **`eslint --fix` sweep** (Fork A). Full suite green (14/143, 7/90); inspect the
   diff. Commit alone (`style: apply prettier/eslint --fix across backend`).
3. **`no-unsafe-call: 'off'` in the test override (Fork B) + delete `jwtService`
   (Fork C).** `npx eslint` now exits 0; suite still green. Commit
   (`chore: clear remaining eslint errors in e2e specs`).
4. **`lint:check` script (Fork E) + drop `continue-on-error` from the eslint step
   (Fork D); trim the `ci.yml` job comment.** Commit.
5. **Documentation** (§4).
6. **Push; confirm the now-blocking `lint` job is green; run the CI negative check**
   (reintroduce one error → red → revert).

**If cut short, stop after step 2** — the backend is prettier-clean and the suite is
green, even if CI is not yet enforcing it. Stopping between 3 and 4 is the awkward
place: the tree is clean but `ci.yml` still says the step is advisory, so a reviewer
cannot tell whether lint is meant to be trusted yet.

---

## 7. Explicitly out of scope for Phase 16 (Future)

- **Branch protection / required status checks on `develop`.** ✅ **Done — issue #6**
  (ahead of Phase 15 Fork F's stated trigger; once the checks are trustworthy the cost
  of flipping early is nil). This phase removed the only real blocker (a lint check that
  could never pass). Applied settings, via the branch-protection API (`Settings →
  Branches` shows the same): require status checks `lint`, `test`, `e2e` (not strict /
  "up to date"); require a pull request, **0 required approvals** (so the solo author
  still self-merges, but nothing merges red); `enforce_admins` off (author can push
  directly in a pinch); `frontend` deliberately **not** required; force-pushes and
  branch deletion disabled.
- **Pre-commit hooks (husky / lint-staged)** — Fork G. **Trigger:** lint/prettier
  drift recurs despite the blocking CI check.
- **Promoting `no-floating-promises` and `no-unsafe-argument` from `warn` to `error`**
  — `eslint.config.mjs` sets both to `warn` deliberately. Tightening them is a separate
  decision about rule strictness and would surface its own set of call sites to fix;
  this phase only gets the tree to pass the rules **as they are configured today**.
- **Coverage reporting / a coverage gate** — as Phase 15 §7. Unchanged.
- **A frontend lint or typecheck** — the frontend is plain JS with no toolchain by
  design (Phase 13). Same trigger as Phase 13 §7's frontend-build-step line.
- **Bringing `docs/learning-notes/` current** — frozen at Phase 8, eight phases behind.
  Named in Phase 15 §7 as its own focused work (a `docs:` commit like `9649e0e`, or a
  numbered phase); still not this phase's problem, recorded so it is not mistaken for
  covered.
- **A shared throttle store** (Phase 8 §7), **an `audit_events` retention policy**
  (Phase 9 §7), **deleting the `mockFetch` / `?state=` scaffolding** (Phase 13 §7),
  **catalogue paging** (`docs/phase-14-plan.md`, unimplemented), **searchable pickers**
  (Phase 14 §7) — all still parked with their triggers.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [ ] `npx eslint "{src,apps,libs,test}/**/*.ts"` (and the new `npm run lint:check`)
      exits `0` on the backend tree.
- [ ] `.github/workflows/ci.yml`'s eslint step no longer has `continue-on-error` — a
      lint error fails the `lint` job and the run. Verified by a negative check
      (reintroduce one error → red → revert).
- [ ] The full backend suite is green and **unchanged in count** — `npm test` 14/143,
      `npm run test:e2e` 7/90 — after the formatting sweep and the rule relaxation,
      proving no behaviour changed.
- [ ] The Fork A commit is inspected hunk by hunk and contains only whitespace,
      wrapping, trailing commas, and removed redundant `as` — nothing else.
- [ ] `@typescript-eslint/no-unsafe-call: 'off'` is added **only** to the
      `files: ['**/*.spec.ts', 'test/**/*.ts']` block in `eslint.config.mjs`, and the
      rule still fires on an equivalent pattern in an `src/` file.
- [ ] The unused `jwtService` in `test/users.e2e-spec.ts` is removed (with its import
      if now unused), after confirming no test intended to use it.
- [ ] `.gitattributes` normalises line endings to LF; `git add --renormalize .` shows
      no content diff (or the one-time normalisation is its own explained commit).
- [ ] `backend/package.json` has `lint` (`--fix`, local) and `lint:check` (no fix, CI);
      `ci.yml` runs `lint:check`.
- [ ] **No application behaviour, no migration, no domain document changed** —
      `domain-model.md` and `api.md` not at all; `requirements.md` (sixth no-FR note),
      `business-rules.md` (no-BR line), `product.md` (§11 cross-ref) only. `src/`/`test/`
      edits are formatting + one test-scoped rule + one dead-variable deletion.
- [ ] `README.md` and `backend/README.md` reflect the blocking lint and the
      `lint:check` script; `docs/architecture-observations.md`'s Phase 15 section is
      extended with the informational→blocking change and the branch-protection
      one-click follow-on; `docs/phase-15-plan.md` carries the dated amendment
      correcting the error census.
- [ ] Every fork decided and recorded either way: the `--fix` sweep (A), the
      `no-unsafe-call` relaxation (B), the dead variable (C), the blocking job (D), the
      `lint:check` script (E), `.gitattributes` (F), and pre-commit hooks (G).
