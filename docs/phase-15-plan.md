# Phase 15 Plan — Continuous Integration

Status: Phase 15 — Done locally (full suite + migration-chain + negative check all
verified on the authoring machine — see the amendment below; the first *hosted* CI run
is still pending a `git push`, which was blocked on credentials in the authoring
session)
Last updated: 2026-09-07

**[2026-09-07, on implementation]** Two things settled during the build, recorded here
rather than left to drift from the plan:

- **Fork G resolved to Node `24`**, not the LTS `22` this plan recommends. The owner
  chose to pin to the version already installed locally so local and CI are identical,
  accepting the deviation from LTS. `.nvmrc` is `24`; `backend/package.json` `engines`
  is `>=24 <25`. One-line change if revisited.
- **Local test-database creation uses a helper script, `tools/create-test-databases.mjs`.**
  §2 and §4 assumed `createdb` was available locally; the portable Postgres in `tools/`
  turned out to be a *stripped* build (only `initdb`, `pg_ctl`, `postgres` — no
  `createdb`, no `psql`). The helper connects with the `pg` client already in
  `backend/node_modules` and issues `CREATE DATABASE`. Its first form did a bare
  `import 'pg'`, which Node resolves relative to the script's own directory (`tools/`,
  which has no `node_modules`) — fixed to resolve `pg` explicitly from
  `backend/package.json` via `createRequire`, so it runs from any working directory.
  **CI is unaffected** — GitHub's Linux runners have the real `createdb`, which is what
  `ci.yml` uses.
- **`npm run lint` is not CI-safe, and the committed tree is not lint-clean.** The
  script is `eslint --fix` — it rewrites files instead of checking them, and running it
  once during implementation reformatted ~12 unrelated files (pure prettier
  line-wrapping) and still reported errors it cannot auto-fix. Those errors predate
  this phase; "full suite green" in twelve DoD checklists never included a clean lint,
  because `--fix` quietly rewrites on every local run and the errors scroll past. This
  is precisely the "green was a claim about one machine" thesis (§"why now") proving
  itself the moment CI was wired. **Handled without widening scope:** the `lint` job
  runs `nest build` as the blocking typecheck (clean) and runs `npm run lint` as an
  *informational, non-blocking* step (`continue-on-error`). A check-mode lint script
  plus clearing the errors is a named follow-up (§7) — this phase does not touch
  `src/` or `test/`.

  **[2026-09-07, superseded by Phase 16]** The "6 errors" figure above was taken
  mid-`--fix` and undershot. A clean check-mode run (`npx eslint "{src,apps,libs,test}
  /**/*.ts"`) on the committed tree was **29 errors across ~15 files**: 22
  `prettier/prettier` + 2 `no-unnecessary-type-assertion` (24 auto-fixable) + 4
  `no-unsafe-call` + 1 unused var (5 manual; a 6th unused-var appeared once `--fix`
  removed the type assertions that had been referencing an import). `docs/phase-16-plan.md`
  cleared all of them, added a `--fix`-free `lint:check` script, and made the `lint`
  job's eslint step blocking. The §7 "A proper lint gate" bullet is done.
- **Verification run on the authoring machine (portable Postgres started for it).**
  All three checks the plan calls for locally now pass on the committed tree:
  - **Migration chain from empty (§1 Fork D, §"why now" — the flagged high-risk step):**
    dropped and recreated `smart_inventory_e2e` empty, ran `npm run migration:run` —
    **all 10 migrations applied cleanly**, in order, `InitSchema` → `AddAdjustmentRequests`,
    leaving the 8 expected tables. No migration-chain bug.
  - **Full suite (§5 parity check):** `npm test` → **14 suites, 143 tests, all pass**
    against a freshly created `smart_inventory_test`; `npm run test:e2e` → **7 suites,
    90 tests, all pass** against the freshly migrated `smart_inventory_e2e`. (The one
    `ERROR [AuditService] … connection lost` line is a test tearing the DataSource down
    mid-request while a best-effort audit write is in flight — BR-082 logs and swallows,
    the test passes; it is pre-existing noise, not a failure.)
  - **Negative check (§5, §6 step 6):** temporarily broke one assertion in
    `suppliers.service.spec.ts`; `jest` exited `1`. The `test` and `e2e` steps in
    `ci.yml` carry no `continue-on-error`, so a red test → red job → (once it is a
    required check) red PR. Sentinel reverted; `git diff` on that file is clean.
  - **Still pending:** the first run on GitHub's hosted runners. `git push` of the
    `phase-15` branch was blocked on credential entry in the non-interactive authoring
    session; the owner runs `git push -u origin phase-15` and watches the Actions tab.
    The local run above is the strongest available predictor that it will be green.
Scope decided with the project owner: **stand up a CI pipeline that runs the whole
test suite — lint, unit, integration, e2e, and (once it exists) the frontend
`node --test` suite — against a clean, from-scratch environment on every push and pull
request, using GitHub Actions and a Postgres service container** — and nothing else.
Scoped the same way `phase-11-plan.md` was scoped to bounded reads, `phase-12-plan.md`
to adjustment approval, `phase-13-plan.md` to the frontend module split, and
`phase-14-plan.md` to catalogue paging: one headline change, an explicit out-of-scope
list, no punch-list riding along.

This phase is **infrastructure-only and adds no capability** — like Phase 13, its
correctness criterion is that the application after it is byte-for-byte the application
before it. The only things that change are a new `.github/` directory, a `.nvmrc`, an
`engines` field, and documentation.

## Why this phase, why now

Every plan since Phase 3 ends its "Definition of done" with a line of the same shape —
*"Full backend suite green — unit, integration, and all e2e specs."* That green is
real, but it is asserted **by one person, on one machine, by hand.** The suite has the
following shape, taken from the repository rather than from memory:

| Layer | Command | Needs Postgres | How it gets a schema |
|---|---|---|---|
| Lint / typecheck | `npm run lint`, `nest build` | no | — |
| Unit + integration | `npm test` (`jest`, `testRegex: .*\.spec\.ts$` — matches `*.integration.spec.ts` too) | **integration specs yes** | `createTestDataSource()` → `smart_inventory_test`, `synchronize: true` + `dropSchema: true` (builds and drops its own schema; needs only the database to *exist*) |
| e2e | `npm run test:e2e` (`jest-e2e.json`) | **yes** | `smart_inventory_e2e`, app runs `synchronize: false`; specs `TRUNCATE` — the schema must already be there, put there by `migration:run` |
| Frontend | `npm test` in `frontend/` (`node --test`) | no | — (arrives in Phase 14, Fork G) |

**The honest "why now", in the register Phase 11 §"why now" used for the empty
transaction table and Phase 14 §"why now" used for its unfired trigger:** no regression
has visibly slipped through, and with one contributor pushing straight to `develop`,
CI's classic payoff — catching a teammate's break before it reaches trunk — is muted.
What has changed is not a hunch:

- **The suite is this project's primary correctness argument, and it runs in exactly
  one place.** Phases 10 and 12 shipped migrations; nothing re-runs the migration chain
  from an empty database, ever — a long-lived local `smart_inventory` / `smart_inventory_e2e`
  has had every migration applied incrementally over months, so a migration that only
  works *against the schema the previous migration left* would never show it. CI running
  `createdb` + `migration:run` on a virgin database every push is the first thing that
  would.
- **The suite depends on unstated preconditions.** "Green" today silently assumes: the
  portable Postgres is running (`pwsh tools/pg-start.ps1`), `smart_inventory_test` and
  `smart_inventory_e2e` exist, and `smart_inventory_e2e` has had `migration:run` against
  it. None of these is written down as a runnable step — `README.md` documents the *dev*
  database setup, not the *test* databases. A CI workflow is the one artefact that
  forces all of them into a script. This is the same "name the precondition nobody
  enforced" move `architecture-observations.md` makes for the `TIMESTAMP` columns
  (Phase 10) and the throttle store (Phase 8).
- **Phase 14 adds a second test runner.** After Phase 14 Fork G, "run the tests" is no
  longer one command in one directory — it is `jest` in `backend/` plus `node --test`
  in `frontend/`. A CI job is the natural home for that composition, and the marginal
  cost of the workflow file is one file against a remote that already exists.
- **These two planned phases can land in either order, and CI-first is better.** Phase
  14's Fork B rewrites *"the most load-bearing query in the app"* (`ProductsService.findAll`,
  moving current-stock into SQL). Landing CI first means that rewrite arrives under a
  green-or-red check on a clean environment, not before one.

**If the owner reads one contributor as reason enough to keep asserting green by hand,
the coherent choice is to say so and shelve `phase-15`, not re-defer it silently** —
the same standard Phase 12 §"why this phase" and Phase 14 §"why now" set for
re-deferral. This plan is written on the judgement that the four points above are
sufficient reason to act now.

**This phase changes no domain document, no application code, and no test.** No new FR
(a build pipeline is not a user goal in `product.md` §4), no new BR, no new entity, no
route, no migration. `api.md`, `requirements.md`, `business-rules.md`, `domain-model.md`,
and `product.md` are untouched except for the "no new FR/BR" cross-reference notes that
Phases 10, 11, 12, and 14 each left. The documents that change are `README.md`,
`architecture-observations.md`, and one learning note (new).

---

## 1. Design decisions

### Fork A — CI provider. Recommended: GitHub Actions

- **A1 — GitHub Actions.** The remote is already `github.com/1102huynh/SmartInventoryManager`
  (`git remote -v`), so there is no third-party account to create, no repository
  integration to authorise. Postgres service containers are a first-class, documented
  feature; the free tier is far more than this suite needs; the workflow lives in the
  repo as reviewable YAML. **Recommended.**
- **A2 — CircleCI / GitLab CI / Woodpecker / Travis.** Each is a separate account, a
  separate integration, and a config format nobody here already knows, for zero gain
  over the provider the code is already hosted on. Rejected.

### Fork B — how CI gets a Postgres. Recommended: a `services:` container, `postgres:17`

- **B1 — a GitHub Actions `services:` Postgres container**, image `postgres:17` to match
  the "PostgreSQL 17.6" the local `tools/` distribution pins (`tools/README.md`),
  health-checked (`pg_isready`), listening on `localhost:5432` inside the job, with
  `POSTGRES_USER=postgres` / `POSTGRES_PASSWORD=postgres`. **Recommended.** CI runs on
  Linux, so the portable *Windows* binaries in `tools/pgsql/` (gitignored anyway) are
  simply not part of this story — `tools/` stays a local-dev convenience, byte-for-byte
  untouched by this phase.
- **B2 — start the portable `tools/pgsql` binaries in CI.** They are Windows binaries
  and not in git; a Linux runner cannot use them. Rejected.
- **B3 — `docker compose` with a Postgres service.** More moving parts than `services:`
  for a single database, and it re-introduces a compose file the project does not
  otherwise have. Rejected.
- **On the version pin:** `postgres:17` explicitly, not `postgres:latest`. The two
  places a major-version drift could actually bite are the `timestamptz` conversion
  migration (Phase 10) and the `SELECT … FOR UPDATE` concurrency test in
  `inventory.service.integration.spec.ts` — both are version-sensitive in ways a green
  suite on a different major would hide. `architecture-observations.md` records the pin
  and the reason.

### Fork C — which layers run in CI, and as one job or several. Recommended: all layers, one workflow, four jobs

- **C1 — one workflow, four jobs:**
  - `lint` — `npm ci`, `npm run lint`, `nest build` (the build is the typecheck). No DB.
  - `test` — `npm ci`, create `smart_inventory_test`, `npm test` (unit + integration).
    Needs the service container.
  - `e2e` — `npm ci`, create `smart_inventory_e2e`, `npm run migration:run` against it,
    `npm run test:e2e`. Needs its **own** service container instance.
  - `frontend` — `npm ci`, `npm test` in `frontend/`. No DB. **Added only once
    `frontend/package.json` exists** (Phase 14 Fork G); until then the job is omitted,
    not stubbed.

  `lint` and `frontend` run with no database and in parallel with everything. `test` and
  `e2e` each get a **separate** service container so they cannot contaminate each other
  — they already use different database names, but a container apiece makes the
  isolation structural rather than a naming convention. **Recommended.**
- **C2 — one job, everything sequential.** Less YAML, but a lint failure then tells you
  nothing about test status, the run is strictly serial, and a flaky e2e blocks the
  unit signal. The extra config for C1 is a few lines. Rejected, narrowly.
- **C3 — unit only in CI; integration and e2e stay local.** Rejected outright: the
  DB-backed layers are *precisely* the ones with hidden environmental preconditions and
  the ones that exercise the migration chain. A CI that skips them checks the code least
  likely to break and ignores the code this phase exists to put under a check.

### Fork D — schema bootstrap for the DB-backed jobs. Recommended: `createdb` for both; `migration:run` for e2e only

The two DB jobs need different things, because the two suites manage their schemas
differently, and the difference is worth preserving rather than papering over:

- **`test` job** — `createTestDataSource()` is `synchronize: true, dropSchema: true`, so
  it builds the schema from the entity classes and drops it around each run. CI needs
  only the *database* to exist: one step, `createdb -h localhost -U postgres
  smart_inventory_test` (or `psql -c 'CREATE DATABASE …'`). A free side effect: this is
  the first thing that continuously checks the entity definitions still `synchronize`
  into a coherent schema.
- **`e2e` job** — `smart_inventory_e2e` is migration-managed (the app runs
  `synchronize: false`; the specs `TRUNCATE`, they never `CREATE`). CI step:
  `createdb … smart_inventory_e2e`, then `DB_DATABASE=smart_inventory_e2e npm run
  migration:run`. **This is the high-value part of the phase**: it runs the entire
  migration chain against an empty database on every push, which nothing has ever done
  — a migration that silently depends on the state a prior migration left is invisible
  to an incrementally-migrated local database and loud here.
- **D-alt — point e2e at `synchronize: true` in CI too.** It would make the `e2e` job
  simpler and it would *stop testing the migration chain*, which is one of the two best
  reasons to have CI on this project at all. Rejected.

### Fork E — environment and secrets. Recommended: plain workflow `env:`, zero secrets

Every value the suite needs is already a non-secret dev default in `backend/.env.example`
— `JWT_SECRET=local-dev-secret-do-not-use-in-production`, `JWT_EXPIRES_IN`, the
`AUTH_*` and `THROTTLE_*` numbers — and the e2e specs already override the throttle
limits themselves, in-file, at module load. So CI supplies only the database
coordinates as job-level `env:`:

```yaml
env:
  DB_HOST: localhost
  DB_PORT: 5432
  DB_USERNAME: postgres
  DB_PASSWORD: postgres
  JWT_SECRET: ci-test-secret
```

- No GitHub Actions **secret** is created, referenced, or needed. There is nothing to
  rotate and nothing to leak.
- Stated explicitly in `architecture-observations.md` and the workflow's own header
  comment: **this is a test workflow, not a deployment pipeline.** A real deploy job —
  out of scope here (§7) — would need real secrets (a production `JWT_SECRET`, database
  credentials); this one deliberately runs entirely on throwaway values, the same way
  `tools/` uses trust auth on a non-default port.

### Fork F — triggers, and whether the check gates merges. Recommended: `push` + `pull_request` + `workflow_dispatch`; no branch protection this phase

- **F1 — run on `push` (any branch) and `pull_request` targeting `develop`.**
  **Recommended.** Make the check *exist and be visible* first.
- **F2 — add `workflow_dispatch`.** A manual "run it now" button, one line, no downside.
  Include it.
- **F3 — required status check / branch protection on `develop`.** This is a **GitHub
  repository setting, not a file in the repo**, and with one contributor pushing
  directly to `develop` it would block the author from their own trunk. Deferred, with a
  concrete trigger (§7): a second contributor, or a `main`/`develop` split where
  `develop` stops being where work lands directly. Turning the check into a gate is then
  one click in repo settings, no code change.
- **F4 — nightly `schedule:`.** Nothing in this suite is time-dependent or reliant on
  external state that drifts (no published dependency ranges, no live API). Push-and-PR
  coverage is sufficient. Rejected.

### Fork G — Node version. Recommended: one version, pinned, matched between local and CI

`backend/package.json` has **no `engines` field** and there is **no `.nvmrc`** — local
Node is currently v24, which is the *current* line, not an LTS. CI picking its own
version would be one more unstated precondition, exactly what this phase is about.

- **G1 — pin one Node LTS** (recommended: **22**, the active LTS) via a repo-root
  `.nvmrc` **and** a `backend/package.json` `"engines": { "node": ">=22 <23" }`, and
  have the workflow's `actions/setup-node` read `node-version-file: .nvmrc`. Local and
  CI then agree by construction. Adding `engines` / `.nvmrc` is a "name the precondition"
  change, in scope for this phase and nothing more. **Recommended.**
- **G2 — a version matrix (`20`, `22`, `24`).** A matrix is for a library that publishes
  to consumers on many runtimes. This is one application, deployed once, to one place.
  Rejected.
- **Note on the bump:** moving the developer's local from v24 to v22 LTS is a
  recommendation, not a requirement of this phase — if the owner prefers to stay on v24
  locally, pin the workflow and `engines` to v24 instead and record that choice. The
  point is that *one* number is written down and both environments read it, not which
  number it is.

---

## 2. What's new

A new directory and three small root files. No `src/` change, no `test/` change, no
`package.json` dependency added (`actions/setup-node` and the Postgres image are CI
infrastructure, not project dependencies).

```
.github/
  workflows/
    ci.yml            # the whole pipeline — lint, test, e2e, frontend jobs
.nvmrc                 # "22" (Fork G)
```

Plus, edited:

- `backend/package.json` — an `"engines"` field (Fork G). No dependency change.
- `README.md`, `docs/architecture-observations.md`, a new learning note (§4).

### `ci.yml` shape (illustrative — the implementer's exact YAML, verified by a green run)

```yaml
name: CI
on:
  push:
  pull_request:
    branches: [develop]
  workflow_dispatch:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
        working-directory: backend
      - run: npm run lint
        working-directory: backend
      - run: npm run build
        working-directory: backend

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
    env: { DB_HOST: localhost, DB_PORT: 5432, DB_USERNAME: postgres, DB_PASSWORD: postgres, JWT_SECRET: ci-test-secret }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
        working-directory: backend
      - run: PGPASSWORD=postgres createdb -h localhost -U postgres smart_inventory_test
      - run: npm test
        working-directory: backend

  e2e:
    runs-on: ubuntu-latest
    services:
      postgres: { image: postgres:17, env: { POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres }, ports: ['5432:5432'], options: >-
          --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5 }
    env: { DB_HOST: localhost, DB_PORT: 5432, DB_USERNAME: postgres, DB_PASSWORD: postgres, JWT_SECRET: ci-test-secret }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm, cache-dependency-path: backend/package-lock.json }
      - run: npm ci
        working-directory: backend
      - run: PGPASSWORD=postgres createdb -h localhost -U postgres smart_inventory_e2e
      - run: DB_DATABASE=smart_inventory_e2e npm run migration:run
        working-directory: backend
      - run: npm run test:e2e
        working-directory: backend

  # Added when frontend/package.json lands (Phase 14, Fork G):
  # frontend:
  #   runs-on: ubuntu-latest
  #   steps:
  #     - uses: actions/checkout@v4
  #     - uses: actions/setup-node@v4
  #       with: { node-version-file: .nvmrc }
  #     - run: npm ci --prefix frontend   # or npm install if no lockfile yet
  #     - run: npm test --prefix frontend
```

The `createdb` client (`postgresql-client`) is present on `ubuntu-latest` runners by
default; if a runner image change ever removes it, the fallback is
`psql "postgresql://postgres:postgres@localhost/postgres" -c 'CREATE DATABASE …'`, or a
one-line `psql` step. Recorded here so the failure mode has a known answer.

### `run-seed.ts`, `data-source.ts`, `test-data-source.ts`, every `*.spec.ts`, `serve.js` — no change

The seeds are not run in CI (nothing under test needs the demo rows — every spec builds
its own fixtures). `data-source.ts` and `test-data-source.ts` already read
`DB_*` / `TEST_DB_DATABASE` from `process.env`, which is all CI sets. No spec is
edited: this phase runs the suite that exists, it does not adjust it. If a spec turns
out to depend on something only true on the author's machine, **that is a finding this
phase exists to surface** — the fix is a follow-up, and §5 says what to do with it.

---

## 3. Frontend changes

**None in application code.** The only frontend-touching part of this phase is the
`frontend` CI job in Fork C, which is *added only when `frontend/package.json` already
exists* (i.e. after Phase 14 Fork G ships). If Phase 15 lands before Phase 14, the
`frontend` job is simply not in `ci.yml` yet, and adding it is a one-block edit in
whichever phase ships second.

If Phase 14 has **not** shipped when this phase is implemented, its plan's §8 gains one
line: *"the frontend `node --test` suite is wired into `.github/workflows/ci.yml` as a
`frontend` job when it is added."* If Phase 14 **has** shipped, this phase adds that job
and ticks that box.

---

## 4. Documentation updates

1. **`README.md`** — a new short "## Continuous integration" section after "Running it
   locally": what runs (lint, unit + integration, e2e, frontend), on what
   (`push` / PR / manual), and the one operational fact a contributor needs — **the
   test databases (`smart_inventory_test`, `smart_inventory_e2e`) that CI creates from
   scratch are the same two the local suite needs**, and the local setup for them
   (create the databases; run `migration:run` against `smart_inventory_e2e`) was
   previously unwritten and is now written, next to the CI description that also does
   it. Plus: the CI badge at the top, and a line that **CI is not yet a required check**
   — a red run does not block a push this phase (Fork F).
2. **`docs/architecture-observations.md`** — a new cross-cutting section,
   *"Continuous integration, and the preconditions it made explicit (Phase 15)"*, in
   that file's established currency:
   - The suite ran in exactly one place for twelve phases; "green" carried unstated
     preconditions (portable PG up, two test DBs created, `migration:run` applied to the
     e2e DB). This phase turns them into a script — the same move this file records for
     Phase 8's throttle store and Phase 10's `TIMESTAMP` columns: *a correctness
     property nobody had written down as enforceable.*
   - **CI is the first thing that runs the migration chain against an empty database.**
     Phases 10 and 12 shipped migrations; an incrementally-migrated local DB can never
     reveal a migration that depends on a prior migration's leftover state. Recorded as
     a concrete latent risk this phase closes, not a hypothetical.
   - The `postgres:17` pin and why (the `timestamptz` migration and the `FOR UPDATE`
     concurrency test are the version-sensitive spots).
   - The Node version pin (`.nvmrc` + `engines`) as one more previously-ambient fact
     made explicit.
   - **What this phase deliberately did not do:** branch protection (a repo setting, not
     a file; deferred until a second contributor — Fork F), a deploy pipeline (needs
     real secrets; this workflow runs entirely on throwaway values — Fork E), and a
     Node matrix (this is one app, not a library — Fork G).
3. **`docs/learning-notes/ci-and-environments.md`** — **new note** (the first learning
   note added since Phase 8's catch-up; see §7 on the broader learning-notes gap this
   phase does *not* try to close). Content, in the learning-notes register — concepts
   explained against this project's real code:
   - GitHub Actions vocabulary: `jobs`, `steps`, `services`, `runs-on`, the trigger
     block, `workflow_dispatch`.
   - **Service containers**: how `services: postgres` becomes `localhost:5432` inside
     the job, why the health-check matters (the job starts before Postgres is ready
     otherwise), and why `test` and `e2e` get one container each.
   - **The two schema-management models this repo already has, side by side**:
     `synchronize: true` + `dropSchema` (integration, `test-data-source.ts` — the DB is
     disposable) versus migration-managed with `synchronize: false` (the app and the
     e2e DB — schema changes are reviewed artefacts). CI treats each the way its suite
     expects, and this is the clearest place in the codebase to see the distinction.
   - **`npm ci` vs `npm install`** and why CI uses the former (respects the lockfile
     exactly, fails instead of updating it).
   - Why this workflow has no secrets, and the one-sentence version of what a *deploy*
     workflow would need that this one does not.
4. **`requirements.md`** — a **fifth** "no new FR" note, beside Phases 7, 8, 10, 11, and
   14's. One line with its reason: a build-and-test pipeline is an engineering practice,
   not a capability in `product.md` §4; no user opens a screen to interact with it.
5. **`business-rules.md`** — a "no new BR" line, the fourth after Phases 10, 11, and 12.
   CI enforces nothing about the business; it enforces that the code enforcing the
   business still passes its tests.
6. **`product.md` §11** — a Phase 15 cross-reference in the Phase 7/10/11/14 register:
   no user goal in §4, no use case in §5, no scope change in §7. Q-4 and Q-7 remain
   open, untouched since Phase 5.
7. **`domain-model.md`, `api.md`** — **no change**, stated here because a reader
   arriving at a new phase checks. Nothing in this phase is about an entity, a column,
   an invariant, or a route contract.

---

## 5. Testing plan

This phase's deliverable *is* a test runner, so "testing" here means: the pipeline runs
the existing suite correctly, and its own steps are proven by a real run.

- **The workflow is validated by a green run on a branch before it merges.** Push
  `phase-15` with `ci.yml` present; every job goes green against the service container.
  A workflow file cannot be reviewed into correctness — the trigger block, the service
  health-check, and the `createdb` step all have failure modes that only a real run
  exposes.
- **Parity check — CI green must mean the same thing local green means.** On the same
  commit, run the full suite locally (`pwsh tools/pg-start.ps1`; the two test DBs;
  `npm test` and `npm run test:e2e` in `backend/`) and confirm the same specs pass and
  the counts match. A spec that passes locally and fails in CI (or the reverse) is a
  **finding**, not a reason to loosen CI: it means the spec depended on something
  ambient (a timezone, an already-seeded row, execution order, a locale). Record it in
  `architecture-observations.md` and fix the spec in a follow-up — do not merge a
  workflow tuned to hide it.
- **The migration chain runs from empty.** The `e2e` job's `migration:run` step against
  a freshly `createdb`'d `smart_inventory_e2e` is itself a test the project has never
  had: all ten migrations apply cleanly, in order, to a database with nothing in it. If
  this step fails, it has found a real latent bug in the migration chain (§"why now").
- **The `frontend` job** (if Phase 14 has shipped): `node --test` in `frontend/` goes
  green in CI, matching a local `npm test` there.
- **Negative check — a deliberately failing test fails the build.** On the branch,
  temporarily break one assertion, push, confirm the relevant job goes red and (once
  Fork F's PR trigger is in) the PR shows the red check. Revert. This proves the
  pipeline actually gates on the result rather than reporting success regardless — the
  CI equivalent of Phase 13's "the inline-handler grep stays at zero" mechanical
  invariant.
- **No new `*.spec.ts` and no edit to an existing one.** If the parity check surfaces a
  brittle spec, its fix is a separate change with its own review, not part of this
  phase — this phase runs the suite as it stands.

---

## 6. Rollout order

Each step leaves `develop` in a state where the app still builds and the suite still
passes locally — CI is additive.

1. **`.nvmrc` + `backend/package.json` `engines`** (Fork G). Trivial, and everything
   after reads them. Confirm local Node satisfies the range (bump local to 22 LTS, or
   pin to the installed version — Fork G).
2. **`ci.yml` with the `lint` job only.** Push the branch; confirm it goes green. This
   proves checkout + `setup-node` + cache + `npm ci` + build work before any database
   is involved. **(Amended on implementation:** the job's blocking check was `nest
   build` only; `npm run lint` ran as a non-blocking informational step because the
   committed tree had pre-existing eslint errors and the script is `--fix`-based.
   **Phase 16 finished this** — the tree is clean, `lint:check` runs in check mode, and
   the eslint step now blocks.)
3. **Add the `test` job** (service container + `createdb smart_inventory_test` + `npm
   test`). Push; green. First proof the service container and integration specs work in
   CI.
4. **Add the `e2e` job** (own container + `createdb` + `migration:run` + `test:e2e`).
   Push; green — **or red, having found a migration-chain bug**, in which case that bug
   is fixed first (it is a real defect, not a CI problem).
5. **Add the `frontend` job** — only if `frontend/package.json` exists (Phase 14 Fork
   G). Otherwise leave the commented block in `ci.yml` and note it in Phase 14's §8.
6. **The negative check** (§5) — break an assertion, confirm red, revert.
7. **The parity check** (§5) — full local run on the same commit, counts match.
8. **Documentation** (§4), including the README badge (available only once the workflow
   has run on the default branch at least once).

**If cut short, the coherent stopping point is after step 3** — `lint` + `test` running
on every push is a real, shippable improvement over nothing, and the e2e job can follow
in a small subsequent change. Stopping between steps 4 and 6 is the bad place: e2e runs
but nothing has confirmed the pipeline actually fails a build on a red test, so a
false-green is possible and unproven against.

---

## 7. Explicitly out of scope for Phase 15 (Future)

- **A deployment / release pipeline** — building an image, publishing it, deploying it
  anywhere. This phase is CI (does the code pass its tests), not CD. **Trigger:** a
  decision to host this application somewhere real; that work needs real secrets, an
  environment target, and a rollback story, none of which belong in a test workflow
  (Fork E).
- **Branch protection / required status checks on `develop`.** A GitHub *repository
  setting*, not a repo file, and counterproductive with one contributor committing
  straight to trunk. **Trigger:** a second contributor, or a `main`/`develop` split
  where trunk stops receiving direct pushes (Fork F). It is a one-click change then.
- **A Node version matrix.** One app, one deploy target, one runtime (Fork G).
  **Trigger:** the project ever being consumed as a library, which is not on any roadmap.
- **A proper lint gate.** ~~`npm run lint` is `eslint --fix` (mutates, does not check)
  and the committed tree has errors it cannot auto-fix plus non-prettier-clean files.
  Making lint a real, blocking check means a check-mode script *and* clearing those
  errors — the latter touches `src/`/`test/`, which this phase does not.~~
  **Done — Phase 16** (`docs/phase-16-plan.md`): 29 errors cleared, `lint:check` added,
  the `lint` job's eslint step is now blocking.
- **Coverage reporting / a coverage gate / a coverage service (Codecov etc.).**
  `jest --coverage` exists as `npm run test:cov`; wiring it to a threshold or an
  external service is a separate decision about what number matters and what to do when
  it drops. Not now.
- **Caching the build output or `node_modules` beyond `setup-node`'s npm cache**,
  parallelising jest with shards, or other speed work. The suite is minutes, not tens of
  minutes; optimise when it hurts.
- **Linting or type-checking the frontend in CI.** The frontend is deliberately plain
  JS with no compile step (`architecture-observations.md`, Phase 13); adding ESLint or
  `tsc` there is Phase 13's rejected "TypeScript on the frontend" wearing a CI hat.
  **Trigger:** the same one Phase 13 §7 set for a frontend build step.
- **Bringing `docs/learning-notes/` up to date through Phase 14** — the notes are frozen
  at Phase 8 (`git log` on that directory), and Phases 9–14 added substantial material
  (`timestamptz` mechanics, the bounded-read convention, row-relationship
  authorization, the frontend module architecture) with no note. This phase adds **one**
  new note for its own subject (§4 item 3) and deliberately does **not** try to
  retro-document six phases as a rider — that is its own focused piece of work (a
  `docs:` commit in the manner of `9649e0e "docs: bring learning-notes up to date
  through phase 8"`, or a numbered phase if the owner wants forks on it). Naming it here
  so the gap is on the record and not mistaken for something this phase covered.
- **A shared throttle store** (Phase 8 §7), **an `audit_events` retention policy**
  (Phase 9 §7), **deleting the `mockFetch` / `?state=` scaffolding** (Phase 13 §7),
  **searchable/typeahead pickers** (Phase 14 §7) — all still parked, still with their
  triggers, none of them this phase's problem.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] `.github/workflows/ci.yml` exists with `lint`, `test`, and `e2e` jobs against a
      `postgres:17` service container. **Hosted run pending `git push`** (blocked on
      credentials in the authoring session); the equivalent suite is green locally on
      the committed tree — see the amendment at the top.
- [x] The `e2e` job creates `smart_inventory_e2e` from nothing and runs the **entire
      migration chain** (`migration:run` from empty) before `test:e2e`. Verified
      locally: 10/10 migrations apply cleanly from an empty database. No bug found.
- [x] The `test` job creates `smart_inventory_test` from nothing; the integration specs'
      own `synchronize`/`dropSchema` handles the schema. Verified locally: helper
      created the DB, `npm test` green (14 suites / 143 tests).
- [x] A deliberately broken assertion makes the relevant job go **red** (verified
      locally — `jest` exits `1`, and the `test`/`e2e` steps have no `continue-on-error`;
      sentinel reverted, file diff clean).
- [x] Local and CI agree: full suite run locally on the committed tree — `npm test`
      14/143, `npm run test:e2e` 7/90, all pass. First hosted run will confirm CI
      matches; any divergence goes to `architecture-observations.md` as a finding.
- [x] `.nvmrc` (`24`) and `backend/package.json` `"engines": ">=24 <25"` pin one Node
      version; the workflow reads `.nvmrc`; local Node (24.20) satisfies it. Owner's
      choice of 24 over LTS 22 is recorded (Fork G, the amendment, and
      `architecture-observations.md`).
- [x] Postgres is pinned to `17` with the reason recorded (`timestamptz` migration, the
      `FOR UPDATE` concurrency test).
- [x] The workflow uses **no** GitHub Actions secret; every value is a throwaway dev
      default, and `ci.yml`'s header comment and `architecture-observations.md` both say
      this is a test workflow, not a deploy pipeline.
- [x] The `frontend` job is **not** present (Phase 14 has not shipped, so
      `frontend/package.json` does not exist); the commented block is in `ci.yml` and
      the README notes the wiring as pending Phase 14.
- [x] **No application code, no test, no migration, no seed, and no `serve.js` change** —
      confirmed by `git diff --stat` (13 files: `.github/`, `.nvmrc`, the helper, 3
      READMEs/package files, 5 docs). The suite that runs in CI is the suite that
      exists today. *(One `src` spec was edited for the negative check and reverted
      byte-for-byte — `git diff` on it is clean.)*
- [x] **No domain document changed:** `domain-model.md` and `api.md` not at all;
      `requirements.md` (a fifth no-FR note only), `business-rules.md` (a no-BR line
      only), `product.md` (a §11 cross-ref only).
- [x] `README.md` documents the CI pipeline **and** the previously-unwritten local
      test-database setup, carries the status badge, and states CI is not yet a required
      check.
- [x] `docs/architecture-observations.md` records the phase in its cross-cutting
      register: preconditions made explicit (incl. the pre-existing lint-cleanliness
      gap), the migration-chain-from-empty check, the `postgres:17` and Node pins, and
      what was deliberately deferred (branch protection, deploy, matrix).
- [x] `docs/learning-notes/ci-and-environments.md` exists — GitHub Actions vocabulary,
      service containers, the two schema-management models this repo runs side by side,
      `npm ci` vs `npm install`, and why there are no secrets.
- [x] Every fork was decided and recorded either way: provider (A), Postgres provisioning
      (B), which layers and job layout (C), schema bootstrap (D), env/secrets (E),
      triggers and gating (F), and Node version (G).
