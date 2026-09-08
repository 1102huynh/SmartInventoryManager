# Phase 22 Plan — `audit_events` retention (opportunistic prune)

Status: Phase 22 — Implemented
Last updated: 2026-09-08
Scope decided with the project owner: **bound `audit_events` to a rolling one-year
window by deleting rows older than that, using the opportunistic probabilistic sweep
Phase 21 already established for `throttle_hits` rather than a scheduler** — and nothing
else. This is issue #12, and it is the follow-on Phase 9 §7 named by hand:

> **A retention or pruning policy** — and unlike most entries here, this one has a
> concrete trigger rather than a vague someday. `audit_events` grows without any user
> acting (§1), almost entirely from `login_failed`. When the table is large enough to
> notice — a slow audit screen, or a backup size that surprises someone — the answer is
> a scheduled `DELETE FROM audit_events WHERE created_at < now() - interval '1 year'`.
> It is out now because this project has no scheduler of any kind, and adding one to run
> a cleanup nobody yet needs would be the premature infrastructure
> `architecture-observations.md` has argued against since Phase 2.

The owner has confirmed the trigger is now met — real evidence of the table's growth
becoming a problem — so this phase acts on it, having declined to before (Phases 10, 11,
12, 14–17 each re-listed it as still parked). The owner also chose the **opportunistic
sweep** over a scheduler and a **hard `DELETE` at one year** over any rollup.

Scoped the same way every phase in this series has been: one headline change, an
explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

Phase 9 built the audit log and, in the same plan (§1 "Newest first, capped, no
pagination"), was explicit that this table is different from every other one in the app:

> **the audit table grows without any user doing anything.** Every failed login anywhere
> on the internet writes a row. `inventory_transactions` only grows when a colleague
> records a movement.

Phase 9 capped the *read* (`GET /audit-events`, `limit` default 100 / max 500) and
deferred capping the *table*, with the §7 trigger quoted above. Phase 11 later observed
(`architecture-observations.md`, "unbounded reads") that the real reason a table like
this needs bounding is not "an adversary supplies the rows" but simply "its size is a
function of how long the business has been running" — and `audit_events` was merely the
first table where that became *visible* because the rows arrive uninvited.

**Honesty about the trigger, in the register this project uses:** Phase 21's framing —
"act on a trigger once it is genuinely met, having declined to act before" — is the
standard. The owner reports the table is now large enough to notice, which is exactly
the `slow audit screen / surprising backup size` condition Phase 9 §7 wrote down. This
phase does not re-argue whether a bound is needed; Phase 9 already decided it would be,
and named the mechanism-shaped question ("this project has no scheduler") as the only
thing holding it. Phase 21 answered a structurally identical question — reclaiming
expired `throttle_hits` rows without a scheduler — and this phase reuses that answer.

---

## 1. Design decisions

### The mechanism: an opportunistic probabilistic prune on `record()`, not a scheduler

Phase 9 §7 said "a *scheduled* `DELETE`". A scheduler is still declined, for the reason
Phase 9 §7 itself gave and Phase 21 re-affirmed twice:

- **`@nestjs/schedule` was refused in Phase 12** (`docs/phase-12-plan.md` §7 names it as
  the kind of runtime dependency this codebase keeps saying no to) **and again in Phase
  21 Fork C2** ("a new runtime dependency for one `DELETE`, against this codebase's
  repeated refusal to add dependencies").
- **`pg_cron` was refused in Phase 21 §7** — it is infrastructure the local `tools/`
  Postgres and the CI `postgres:17` service container do not have, so a policy that
  depended on it would be untested everywhere the rest of the suite runs.

Phase 21's Fork C settled on **C1 + C4** for `throttle_hits`: an opportunistic sweep
that runs inside the hot-path write with small probability, plus a one-shot sweep on
`OnApplicationBootstrap`. Phase 22 applies the same pattern to `audit_events`:

- **`AuditService.record()` calls `maybePrune()`** after every write. With probability
  `RETENTION_SWEEP_PROBABILITY` (`0.001`, the exact rate
  `postgres-throttler.storage.ts` uses) it fires
  `DELETE FROM audit_events WHERE created_at < now() - (365 * interval '1 day')`,
  fire-and-forget, errors caught and logged.
- **`AuditService implements OnApplicationBootstrap`** and prunes once, unconditionally,
  at startup — so an instance that was stopped for a long time (or has never run the
  prune because it is new) does not wait for the dice.

`record()` is the right host for the same reason `increment()` was right for the
throttle sweep: it is the table's own growth driver. Every `login_failed` — the rows
that dominate this table — calls `record()`, and so does every administrative write. On
a live system `record()` runs many times a day, so a 1-in-1000 gate still prunes
several times daily without ever putting a `DELETE` on a request's critical path (it is
not `await`ed; the request has already returned by the time it runs).

**No new caller, no new module, no new dependency, no scheduler.** The prune lives in
the service that already owns the table.

### The prune is best-effort — a fourth operation of that shape, deliberately

`maybePrune()` swallows its errors exactly the way `AuditService.record()` itself does
(BR-082, "a record, not a proof") and the way Phase 21's sweep does. A `DELETE` that
deadlocks, times out, or hits a full disk must never fail — or even slow — the login or
the admin action that happened to roll the dice.

The cost, stated plainly because `architecture-observations.md` tracks operations of
this shape: **a sustained run of prune failures would let the table grow unbounded
again, silently.** That is the same trade the best-effort *write* already made — the
audit subsystem now has two best-effort, unmonitored background behaviours, both on the
premise that a small business's audit log is operational evidence with a shelf life, not
a durability-critical store. The startup prune (`OnApplicationBootstrap`) is a partial
backstop: every deploy or restart clears whatever the probabilistic path missed.

### The append-only rule bends, and this is the substantive documentation change

BR-082 currently says rows in `audit_events` "are never updated or deleted by any code
path in this application," and `domain-model.md` §8 cites the table as the **second
instance of the immutable-table rule** after `inventory_transactions`. Phase 22 makes
that literally false, so both must change — carefully, because the useful part of the
rule survives:

- **Nothing edits a row, and nothing deletes a *chosen* row.** There is still no
  `UPDATE`, no "correct this event," no "remove this entry" — the audit log is still
  append-only in the sense that matters for trust: an Owner reading it cannot have had a
  specific event quietly altered or removed.
- **The table is bounded in age.** A single bulk, time-based `DELETE` drops everything
  past the window. It takes no id, no filter beyond `created_at`, and cannot be aimed.

The distinction the docs now draw is **immutable-in-shape vs. retained-forever**.
`inventory_transactions` is both: BR-050/BR-051 make it business history that must never
be lost. `audit_events` is only the first: Phase 9 §7 always signalled that retention
was coming, and BR-082 already called the log "a record, not a proof." So the two
tables, cited together by §8 since Phase 9, now diverge on purpose — and §8 says why.

### One year, hard delete — Fork A: a constant, not configuration. Recommended: constant.

Phase 9 §7 named "1 year" and the owner confirmed it, with a hard `DELETE` and no
rollup. The only open question is whether the window is a constant in the service or a
`configuration.ts` knob.

- **A1 — a `RETENTION_DAYS = 365` constant in `audit.service.ts`. Recommended.** This is
  the deliberate inverse of Phase 8's "configuration, not constants," and Phase 9 §1
  already made the same call for this feature's sibling number (the `limit` cap: "The
  cap is a constant, not configuration … No deployment tunes a page size, and no test
  needs to vary it"). Both of Phase 8's criteria for making a number configurable fail
  here: (1) no deployment of *this* product — a 1–10 person business's inventory app —
  tunes an audit-retention window, and (2) no test needs to vary it, because a test
  backdates `created_at` directly rather than waiting a year (see §5). Adding a knob
  nobody turns is precisely what Phase 9 §1 warned keeps `configuration.ts` accreting.
- **A2 — `AUDIT_RETENTION_DAYS` env → `configuration.ts`, default 365.** The argument
  *for* is that a retention window is the kind of thing an operator with a compliance
  obligation genuinely might need to change — unlike a page size. It is a real argument,
  and it is why this is a recorded fork rather than an omission. It is not taken because
  only one of Phase 8's two criteria is met, and promoting a constant to config later is
  a five-line change with ample precedent (`TRUST_PROXY` was added in Phase 21 exactly
  when it became load-bearing). Until an operator actually needs a different number, the
  constant is the boring choice this codebase favours.

### No migration, no schema change

The prune's `WHERE created_at < …` is served by `IDX_audit_events_created_at`, created
in Phase 9's `AddAuditEvents` migration and until now used only by the `?days=` read
filter. `created_at` is `timestamptz` (Phase 10), so `now()` minus an interval is
zone-correct with no cast games. There is nothing to add to the schema — stated
explicitly because a reader's instinct on "retention policy" is to look for a migration.

### No new configuration, no `.env.example` change

Follows from Fork A1. The deliberate inverse of Phase 21, which *did* add a setting
(`TRUST_PROXY`) — recorded here so the difference is a decision, not an oversight.

### `run-seed.ts` — no change

Consistent with Phase 9 (a seeded audit log "would be fiction") and Phase 21 (the seed
writes no throttle rows). `npm run seed` writes nothing to `audit_events`, so there is
nothing for a prune to interact with on a fresh database, and the startup prune is a
no-op there.

### No FR

`requirements.md` is a functional-requirements document. Reading a bounded log is still
**FR-065**, unchanged — a background prune that an Owner never sees and never triggers
is not a user goal. This is the twelfth "no new FR" note, kin to Phases 7, 8, 10, 11,
14–17, 19, 20, and 21. Unlike those, it **does** add a business rule (BR-090), because
"how long the audit log is kept" is a statement about the business's relationship to its
own records, not an implementation detail — the same reason BR-082 exists at all.

### One flagged scope fork

**Fork A — retention window as a constant vs. configuration.** Decided above:
**constant**, `RETENTION_DAYS = 365`. Recorded either way per this series' convention.

(There is no Fork B. The throttle-store phase had forks about `UNLOGGED` storage and
`trust proxy` because it added a table and touched the request pipeline; this phase adds
neither.)

---

## 2. What's new (backend)

### Dependency

**None.** No `@nestjs/schedule`, no `pg_cron`. `record()` already has a repository; the
prune is one more `repository.query(...)` on it, the same raw-SQL-through-the-repo shape
`postgres-throttler.storage.ts` uses.

### `audit/audit.service.ts`

| Addition | What it is |
|---|---|
| `RETENTION_DAYS = 365` | Module constant. The window. Fork A1. |
| `RETENTION_SWEEP_PROBABILITY = 0.001` | Module constant. The same rate the throttle sweep runs at. |
| `implements OnApplicationBootstrap` | `onApplicationBootstrap()` runs one unconditional prune at startup (Fork C4, reused). Errors logged and swallowed — a failed prune must not stop the app booting. |
| `record()` gains a trailing `this.maybePrune()` | Outside the write's `try/catch`, fire-and-forget. Runs even after a failed save (a table failing writes because it is full is exactly one that needs trimming). |
| `private maybePrune()` | `if (Math.random() >= RETENTION_SWEEP_PROBABILITY) return;` then `void this.pruneToRetentionWindow().catch(log)`. |
| `private pruneToRetentionWindow()` | `DELETE FROM audit_events WHERE created_at < now() - ($1::int * interval '1 day')` with `[RETENTION_DAYS]`. One bulk, time-based statement; takes no id. |

`findAll()` and the `RecordAuditEvent` interface are **unchanged**. No controller
change, no DTO change, no route.

### No new file, no new module

The prune is four private-method lines and two constants in a service that already
exists and is already imported by every module that writes an event. Phase 21 needed a
new `throttler/` directory because a `ThrottlerStorage` is a distinct injectable with
its own lifecycle; a retention sweep on an existing table is not.

### The three entity registries — untouched

No new entity, so `database.module.ts`, `data-source.ts`, and `test-data-source.ts` are
all unchanged. (Called out because every table-touching phase since Phase 6 has had a
line about these three.)

---

## 3. Frontend changes

**None.** Stated because a reader will check. The audit screen (`#/audit`, Phase 9 §3)
renders whatever `GET /audit-events` returns; after this phase that list simply never
contains an event older than a year. There is no "retention" control, no "show archived"
toggle, no copy about it — the same reasoning Phase 9 §3 used to keep the screen a
plain reader ("This is a screen someone opens when they have a question, not a
monitor"). No `frontend/` file changes and the `node --test` suite is not touched.

---

## 4. Documentation updates

1. **`business-rules.md`** —
   - **BR-082 amended.** The clause "rows are never updated or deleted by any code path
     in this application" becomes "rows are never *updated*, and never individually
     deleted — the only deletion is the age-based retention prune (BR-090), which is
     bulk and time-based and cannot target a chosen row." The `actorIp` note's "in a
     table with no retention limit" becomes "retained at most one year (BR-090)."
   - **BR-090 added** (next free number after BR-089) in the Audit Log section: *The
     audit log is pruned to a rolling one-year window.* Rows whose `created_at` is more
     than a year old are deleted; the deletion is best-effort (an opportunistic
     probabilistic sweep on `AuditService.record()` plus a one-shot at startup — no
     scheduler), so like the write it is a *record*, not a *proof*. Cross-references
     BR-082, and Phase 9 §7 as the origin.
   - The "no new BR" running list is **not** extended — this phase adds one.

2. **`architecture-observations.md`** — a Phase 22 cross-cutting section. It records:
   the opportunistic-probabilistic-prune pattern is now used **twice** (throttle sweep,
   audit retention), which — like the "three unenforced preconditions" observation — is
   the pattern this codebase reaches for instead of a scheduler, not a coincidence; the
   audit subsystem now has **two** best-effort unmonitored background operations (write
   and prune) on one premise; and this closes the last "grows without bound" concern
   specific to `audit_events` (Phase 11 capped the read; Phase 22 caps the table). It is
   **not** one of that file's three named unenforced preconditions being retired — it is
   a Phase 9 §7 deferral with its own trigger — but it is adjacent to the best-effort
   audit-write one and the section says so.

3. **`requirements.md`** — an "Audit Retention (Phase 22 — no new FR)" note beside the
   Phase 20/21 ones: FR-065 reads exactly as before; the new rule is in
   `business-rules.md` (BR-090); recording the absence of an FR keeps the table honest.

4. **`api.md`** — title bumped to Phase 22. The Audit Log section gains one sentence:
   results never include events older than one year, because rows past that age are
   pruned (BR-090). No route-table change, no query-parameter change, no response-shape
   change.

5. **`README.md`** — Current phase to Phase 22; Phase 21 moves to "Earlier phases".
   Note: the audit log is bounded to a rolling one-year window by an opportunistic sweep
   (no scheduler, no new dependency, no migration); events past a year are permanently
   discarded, which is expected, not data loss (BR-090, Phase 9 §7).

6. **`domain-model.md` §8** — the `audit_events` bullet is amended. It stays an example
   of "no `updated_at` because nothing edits a row," but gains: it is **no longer** an
   example of *retained forever* — Phase 22 bounds it to a one-year window (BR-090),
   deliberately diverging from `inventory_transactions`, which is business history and
   is kept for good (BR-050/BR-051). The immutable-table rule is about the absence of
   `UPDATE` and targeted `DELETE`, which still holds; it never implied unlimited
   retention, and Phase 9 §7 always flagged retention as a separate, coming decision.

7. **`product.md` §11** — a Phase 22 cross-reference entry in the "no scope change"
   shape (§4 gains no user goal, §5 no use case, §7 no scope; issue #12 / Phase 9 §7
   named; Q-7 still open).

8. **`docs/learning-notes/database-access.md`** — a short addition: the
   opportunistic-probabilistic maintenance sweep as this project's deliberate substitute
   for a job scheduler, now on its **second** use (Phase 21's `throttle_hits`, Phase
   22's `audit_events`), and the two properties that make it legitimate — the work must
   tolerate being skipped (bounded or ephemeral loss, never correctness) and must be
   cheap enough that piggybacking it on a hot-path write is invisible.

Phase 9's §7 line and `architecture-observations.md`'s existing Phase 9 section are
**left as written** — dated records of what was true then; the Phase 22 section is where
"now done" is recorded, the same convention Phase 21 followed for Phase 8 §7.

---

## 5. Testing plan

Two properties are easy to get silently wrong — *which* rows a one-year cutoff deletes,
and a prune that is not actually best-effort — and each gets a pinning test. The split
follows the project's convention: SQL semantics at the integration layer, wiring at the
unit layer.

- **Unit — `audit.service.spec.ts`** (extended; the repository is already a fake, now
  with a `query: jest.fn()`):
  - `record()` fires the `DELETE` **only when the probability roll passes** —
    `jest.spyOn(Math, 'random').mockReturnValue(0)` → `repo.query` called with a
    `DELETE FROM audit_events` statement and `[365]`; `mockReturnValue(0.5)` → not
    called. Pins the gate.
  - `record()` **still resolves when the prune query rejects** — the best-effort
    property, the direct analogue of the existing "does not throw when the repository
    `save` rejects" test. Without it, a refactor that drops `maybePrune`'s `.catch`
    turns a deadlocked cleanup into a 500 on a user's login.
  - `onApplicationBootstrap()` prunes **unconditionally** (does not call `Math.random`)
    and does not throw when the query rejects.

- **Integration — `audit/audit-retention.integration.spec.ts`** (new, real Postgres via
  `createTestDataSource()`, the same shape as
  `postgres-throttler.storage.integration.spec.ts`):
  - Rows are inserted with a backdated `created_at` through raw SQL (`@CreateDateColumn`
    ignores an assigned value on insert). A row 400 days old and one 366 days old are
    deleted by the prune; one 364 days old and one 1 day old survive — **the window
    boundary belongs to the newer side**. This is the analogue of Phase 8's lockout
    auto-expiry test and Phase 21's window-reset test: it proves the cutoff *cuts where
    it says*, not merely that a `DELETE` ran.
  - `record()` on the opportunistic path (with `Math.random` stubbed to `0`) writes its
    fresh row and drops a pre-seeded stale one — end to end, against a real table.
  - With nothing old enough, the prune leaves every row in place.

- **E2E — no new test.** Consistent with Phase 21, where the sweep itself got no e2e
  (only the cross-instance *sharing* did) because a 1-in-1000 probabilistic path cannot
  be triggered deterministically over HTTP, and the SQL is covered at the integration
  layer. The existing `audit.e2e-spec.ts` is **unaffected**: it seeds no year-old rows,
  so the `OnApplicationBootstrap` prune that now runs on every `app.init()` is a no-op,
  and every one of its assertions about event contents and the Owner-only guard still
  holds. All seven e2e specs must stay green (they exercise `app.init()`, which now
  calls the startup prune — proving it does not break bootstrap).

- **No new frontend test** — no frontend change.

- **Existing suites — must pass unchanged.** The unit change is additive (a new
  `describe` block, a new fake method); no existing service or e2e spec touches
  retention. The full backend suite — unit, the new integration spec, and all seven e2e
  specs — is green.

---

## 6. Rollout order

Each step leaves the suite green and is a no-op from every client's point of view — the
whole phase is invisible to a client until a row is a year old.

1. **`pruneToRetentionWindow()` + `onApplicationBootstrap` + the unit and integration
   specs.** The prune exists and is tested in isolation; `record()` does **not** call it
   yet, so app behaviour is entirely unchanged. Full suite green. De-risks the SQL and
   the startup hook alone.
2. **Wire `this.maybePrune()` into `record()`.** The feature lands — the table now
   trims itself. Full suite green; `audit.e2e-spec.ts` unaffected (no year-old rows).
3. **Documentation (§4)** — the BR-082 amendment and BR-090, the
   `architecture-observations.md` section, the no-FR note, `api.md`, `README.md`,
   `domain-model.md` §8, `product.md` §11, and the learning-note addition. Not optional
   in any cut of this phase: the amended append-only rule is the deliverable that
   outlasts the code.

Steps 1–2 are individually shippable and observably no-ops on any database younger than
a year; if step 2 goes wrong, step 1 can stay.

---

## 7. Explicitly out of scope for Phase 22 (Future)

- **A real scheduler** — `@nestjs/schedule`, `pg_cron`, a cron entry calling a script.
  The opportunistic sweep is the proportionate mechanism at this scale, the same call
  Phase 21 Fork C made for `throttle_hits`. If audit volume ever grows to where a
  1-in-1000 gate cannot keep up (it would take a sustained flood the throttle is
  supposed to stop), a scheduled job is where that goes — measured, not assumed.
- **A configurable retention window** (Fork A2). Promote `RETENTION_DAYS` to
  `AUDIT_RETENTION_DAYS` in `configuration.ts` when an operator actually needs a
  different number — a five-line change with the `TRUST_PROXY` precedent. Named here so
  the constant is a recorded decision, not a gap.
- **Rollup, archival, or cold storage of pruned rows** — aggregating old `login_failed`
  rows into counts before deleting the detail, or shipping them to a file/bucket first.
  The owner chose a hard delete; BR-082's "a record, not a proof" already sets the
  expectation that old detail is not kept.
- **Export before prune** (CSV/JSON/printable) — still Phase 9 §7's separate deferral,
  a real request the moment someone needs to hand the log to an accountant or insurer,
  and a genuinely separate feature (a format, a download route, a filename convention).
- **Per-event-type retention** — keeping `account_locked` or `user_password_reset`
  longer than `login_failed`. One window for the whole table; revisit only if a
  concrete need appears. A `WHERE event_type IN (…)` clause is where it would go.
- **Pruning `inventory_transactions`** — it is business history, retained forever
  (BR-050/BR-051, `domain-model.md` §8). This phase bounds `audit_events` and only
  `audit_events`; the divergence is the point.
- **A metric, log line, or alert on how many rows each prune deletes** — observability
  the project does not have (Phase 21 §7's "throttle observability" line stands). The
  prune logs only on failure.
- **Tamper-evidence for what remains** — hash chaining, append-only DB roles, WORM
  storage. Phase 9 §7 already listed these; a retention window does not change that they
  are unrequested.
- **Making the prune synchronous or transactional with the write** — it is deliberately
  neither, the same best-effort acceptance BR-082 made for the write itself.
- **The `GET /categories` reference-cache read** — the last of
  `architecture-observations.md`'s three named unenforced preconditions still open after
  Phase 21. Untouched here; this phase closes a Phase 9 §7 deferral, not a precondition.
- **Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] `audit_events` rows older than one year are deleted, by a bulk time-based
      `DELETE` that takes no id and cannot target a chosen row.
- [x] The prune runs as an opportunistic probabilistic sweep on `AuditService.record()`
      (`RETENTION_SWEEP_PROBABILITY = 0.001`, the throttle sweep's rate) plus one
      unconditional prune on `OnApplicationBootstrap` — **no scheduler, no
      `@nestjs/schedule`, no `pg_cron`, no new dependency, no new module.**
- [x] The retention window is a constant (`RETENTION_DAYS = 365`), not configuration —
      Fork A decided and recorded, with the reason (both of Phase 8's
      make-it-configurable criteria fail here, and Phase 9 §1 made the same call for the
      sibling `limit` cap).
- [x] **No migration and no schema change** — the prune reuses
      `IDX_audit_events_created_at` from Phase 9; `created_at` is already `timestamptz`.
- [x] The prune is best-effort: a failing `DELETE` is caught, logged, and never
      propagates — with a unit test that would catch the loss of the `.catch`, the
      analogue of the existing best-effort-write test.
- [x] An integration test against real Postgres proves the one-year cutoff deletes rows
      past the window and keeps rows inside it, boundary included on the newer side.
- [x] `BR-082` no longer claims rows are never deleted; **`BR-090`** states the
      one-year retention window and that it is best-effort; `domain-model.md` §8
      records that `audit_events` is immutable-in-shape but no longer retained-forever,
      diverging from `inventory_transactions` on purpose.
- [x] `architecture-observations.md` records the opportunistic-prune pattern's second
      use and the audit subsystem's second best-effort background operation;
      `requirements.md` (no new FR), `api.md` (Phase 22, the retention sentence),
      `README.md`, `product.md` §11, and the `database-access.md` learning note all
      reflect this phase.
- [x] `frontend/` is untouched; `run-seed.ts` is untouched.
- [x] Full backend suite green: unit (including the extended `audit.service.spec.ts`),
      the new `audit-retention.integration.spec.ts`, and all seven existing e2e specs
      (which now exercise the startup prune on every `app.init()`).
