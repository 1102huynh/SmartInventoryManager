# Continuous Integration and Test Environments (GitHub Actions)

## Concept

**Continuous integration** is a machine that runs your checks — lint, typecheck,
tests — automatically, on a clean environment, every time code is pushed. The point is
not the automation for its own sake; it is that "the tests pass" stops being a claim
about one developer's laptop and becomes a claim about a reproducible, from-scratch
environment that anyone can inspect.

This project's CI is one file: `.github/workflows/ci.yml` (added in Phase 15,
`docs/phase-15-plan.md`). It runs on **GitHub Actions**, the CI service built into the
GitHub repository the code already lives in.

## GitHub Actions vocabulary

A **workflow** is a YAML file under `.github/workflows/`. It has three top-level parts:

- **`name`** — what shows up in the Actions tab.
- **`on`** — the triggers. This project's workflow runs `on: push` (any branch),
  `on: pull_request` targeting `develop`, and `workflow_dispatch` (a manual "Run
  workflow" button). A `schedule:` trigger (cron) also exists but this project has
  nothing time-dependent to run nightly.
- **`jobs`** — the actual work. Each job runs on a fresh virtual machine
  (`runs-on: ubuntu-latest`), independently and in parallel unless you declare a
  dependency (`needs:`). This project has three: `lint`, `test`, `e2e`.

A job is a list of **steps**. A step is either:

- **`uses:`** — a pre-packaged action. `actions/checkout@v4` clones the repo into the
  VM; `actions/setup-node@v4` installs Node and wires up npm's cache.
- **`run:`** — a shell command. `working-directory: backend` runs it in `backend/`
  rather than the repo root.

### The YAML `on:` gotcha

If you parse `ci.yml` with a generic YAML 1.1 library (like Python's PyYAML), the key
`on` comes back as the boolean `True`, because YAML 1.1 treats `on`/`off`/`yes`/`no`
as booleans. GitHub's own parser does not do this — `on:` is correct and is what every
GitHub example uses. It is only a surprise if you validate the file with an outside
tool. (Quoting keys and string-like values such as `"5432:5432"` avoids a related
1.1 quirk where `MM:SS` is read as a base-60 number.)

## Service containers: getting a real Postgres into a job

Two of the three jobs need a database, because the integration and e2e suites talk to
a real Postgres (see `testing-strategy.md`). GitHub Actions provides this with a
**service container**:

```yaml
services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    options: >-
      --health-cmd pg_isready --health-interval 10s
      --health-timeout 5s --health-retries 5
```

- The `postgres:17` Docker image starts alongside the job. Because the job's steps run
  directly on the VM (not themselves inside a container), the database is reachable at
  `localhost:5432` — which is why `ci.yml` sets `DB_HOST: localhost`.
- **The health check matters.** Without `--health-cmd pg_isready`, the job's first
  `psql`/`createdb` step can fire before Postgres has finished starting, and fail
  intermittently. The health check makes Actions wait until the container reports
  ready before running any step.
- **`test` and `e2e` get one service container each.** They already use different
  database names (`smart_inventory_test` vs `smart_inventory_e2e`), but a container
  apiece makes the isolation structural rather than a naming convention — neither job
  can see the other's data even in principle.
- **`postgres:17`, not `postgres:latest`.** Pin the major version. This project has two
  version-sensitive spots — the `timestamptz` conversion migration (Phase 10) and the
  `SELECT … FOR UPDATE` concurrency test (`inventory.service.integration.spec.ts`) — and
  a silent bump to Postgres 18 could change behaviour under a still-green suite. Local
  dev pins "PostgreSQL 17.6" (`tools/README.md`); CI matches.

## Two schema-management models, side by side

This is the clearest place in the codebase to see a distinction the app makes
everywhere: **how does a database get its tables?**

| | `smart_inventory` (dev), `smart_inventory_e2e` | `smart_inventory_test` (integration) |
|---|---|---|
| Config | `data-source.ts` / `database.module.ts`, `synchronize: false` | `test-data-source.ts`, `synchronize: true` + `dropSchema: true` |
| Schema comes from | **reviewed migration files** (`src/database/migrations/*.ts`), applied by `npm run migration:run` | TypeORM **generating DDL from the entity classes** at connection time, dropped after |
| Why | production data is real; schema changes must be deliberate, reversible, code-reviewed artefacts | this database exists only to be created and thrown away inside a test run, so "match the entities" is exactly right and costs nothing |

`ci.yml` treats each the way its suite expects:

- **`test` job** — `createdb smart_inventory_test`, then `npm test`. The integration
  specs' own `synchronize`/`dropSchema` builds and tears down the schema; CI only has
  to make the empty database exist. (A free side effect: this continuously checks that
  the entity classes still `synchronize` into a coherent schema.)
- **`e2e` job** — `createdb smart_inventory_e2e`, then
  `DB_DATABASE=smart_inventory_e2e npm run migration:run`, then `npm run test:e2e`. The
  e2e specs `TRUNCATE` tables between tests; they never `CREATE` them, so the schema
  has to be there first, put there by the migration chain.

### Why running migrations in CI is the high-value part

A developer's local `smart_inventory_e2e` has had every migration applied **one at a
time, in order, as each was written** — over months. If some migration only works
because of the state the *previous* migration left behind (a table that happened to
exist, a column in a particular position, a row a data migration wrote), a locally
migrated database will never reveal it. The `e2e` job runs `migration:run` against a
**brand-new empty database on every push**, so it would. A red `migration:run` step in
CI is a real bug in the migration chain, not a CI failure to work around.

## `npm ci` vs `npm install`

CI uses `npm ci` (not `npm install`) in every job:

- `npm ci` installs **exactly** what `package-lock.json` says, deleting `node_modules`
  first. It is faster and fully reproducible.
- It **fails** if `package.json` and `package-lock.json` disagree, rather than silently
  updating the lockfile the way `npm install` does. That is the behaviour you want on a
  build machine — a lockfile drift becomes a red build, not a quiet change nobody
  reviewed.
- Practical consequence: when you change `package.json` (Phase 15 added an `engines`
  field), you must run `npm install` locally once so the lockfile picks up the change
  and commit both — otherwise `npm ci` in CI will reject the mismatch.

`actions/setup-node`'s `cache: npm` with `cache-dependency-path: backend/package-lock.json`
caches the npm download directory keyed on the lockfile hash, so a run where
dependencies did not change skips re-downloading them.

## Why there are no secrets

`ci.yml` defines no GitHub Actions **secret**. Every value the suite needs is a
throwaway development default — the same ones in `backend/.env.example`:
`JWT_SECRET=ci-test-secret`, `DB_PASSWORD=postgres`, and the `AUTH_*`/`THROTTLE_*`
numbers (the e2e specs override the throttle limits themselves, in-file). A **test**
pipeline that only ever talks to a disposable container needs nothing real.

A **deploy** pipeline would be different: a real `JWT_SECRET`, real database
credentials, an environment to deploy to, a rollback plan. That is CD, not CI, and it
is deliberately out of scope for this project until it is hosted somewhere real
(`docs/phase-15-plan.md` §7). The one-sentence version: **CI proves the code is good;
CD makes it live, and only CD needs secrets.**

## Node version pinning

Before Phase 15 the project had no `.nvmrc` and no `engines` field — nothing said
which Node it expected, so CI would have picked its own. Phase 15 added a repo-root
`.nvmrc` (`24`) and `backend/package.json` `"engines": { "node": ">=24 <25" }`, and
`ci.yml`'s `setup-node` reads `node-version-file: .nvmrc`. Local and CI now agree by
construction. The number itself (24 — the version this project's developer runs — over
the LTS 22 that the plan recommended) is an owner choice recorded in
`docs/architecture-observations.md`; the lesson is that *some* version is written down
and both environments read the same file.

## What CI here gates, and what it does not do

- `lint`, `test` and `e2e` are **required status checks on `develop`**, and `develop`
  requires a pull request (0 approvals) — a red run blocks the merge (issue #6). This
  is a repository setting (Settings → Branches / the branch-protection API), not a file
  in the repo; the exact settings are recorded in `docs/phase-16-plan.md` §7. The
  `frontend` job runs but is deliberately not required, and administrators are not
  forced through the gate (the solo author can still push directly in a pinch).
- No coverage threshold, no deploy, no Node version matrix, no build caching beyond the
  npm download cache. Each is a deliberate "not yet" in `docs/phase-15-plan.md` §7.
