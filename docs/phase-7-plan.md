# Phase 7 Plan — Audit Timestamps (Consistent `created_at` / `updated_at`)

Status: Phase 7 — Complete
Last updated: 2026-08-24
Scope decided with the project owner: **give every table the audit timestamps its
siblings already have — `created_at` on all of them, `updated_at` on the ones whose
rows can change — and make the convention explicit**, and nothing else. Scoped the same
way `phase-3-plan.md` was scoped to authentication, `phase-5-plan.md` to authorization,
and `phase-6-plan.md` to user management: one headline change, an explicit out-of-scope
list, no punch-list riding along.

## Why this phase, why now

Phase 6 §7 named this as the follow-on, in almost these words:

> **`created_at` / `updated_at` on `users`** — the table has never had them, and
> "account created on" is a nice column on a screen, not a requirement. Adding audit
> timestamps is a reasonable small phase of its own, applied consistently, not a rider
> here.

The obvious way to read that line is "add `created_at`/`updated_at` everywhere." That
reading is wrong, and getting it right is most of this phase's design work, so it goes
first:

- **`products` and `suppliers` have had both columns since day one.** `InitSchema`
  created them as `"created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at"
  TIMESTAMP NOT NULL DEFAULT now()`, and `Product` / `Supplier` carry the matching
  `@CreateDateColumn` / `@UpdateDateColumn`. Nothing to add here.
- **`inventory_transactions` has `created_at` and *deliberately* no `updated_at`.** The
  entity says so in a comment: "BR-051 says these rows are immutable once created —
  notice there is no `UpdateDateColumn` and no UPDATE/DELETE endpoint anywhere for this
  entity." That absence is a decision, not an oversight, and this phase must preserve
  it rather than "finish the set."
- **`users` and `categories` have neither column.** `users` accreted through four
  migrations (`InitSchema`, `AddAuthToUsers`, `AddUserRoleEnum`, `AddUserStatus`) and
  never picked them up; `categories` was built as "the simplest possible entity: no
  status, no relations to manage beyond being pointed at" and stayed that way.

So the actual state is a convention that is **75% implemented and 0% documented**: two
tables have the full pair, one has the create-only variant for a stated reason, and two
have nothing. This phase closes the two-table gap and writes the convention down, so the
next person who adds a table knows what a table is supposed to have and why one of them
is different. It does **not** invent a new capability — there is no new FR, because
"when was this row written" is not a user goal from `product.md` §4; it is data-model
hygiene that happens to also be useful on a screen later.

The framing that makes the whole phase coherent: **an audit timestamp records a fact
about the *row*, and the row's mutability decides which timestamps are meaningful.** A
row that can never change has a creation time and nothing else to say. A row that can
change has both. That single rule already explains every table's current state, and
applying it to `users` and `categories` is the entire backend change.

---

## 1. Design decisions

### The rule is "match mutability," not "match the other tables"

`users` and `categories` both get `created_at` **and** `updated_at`, for the same
reason `products` and `suppliers` have both and `inventory_transactions` has only one:
these rows change after creation. A user is edited (Phase 6: name, email, role, status,
password). A category is renamed (Phase 4: `PATCH /categories/:id`). Every mutation path
that already exists is a reason `updated_at` is meaningful — a column that would sit
frozen forever would be the wrong thing to add.

The tempting shortcut is "categories are barely more than a label, give them
`created_at` only." Rejected: a renamed category with a stale-looking single timestamp
is exactly the confusion this convention exists to prevent, and the `PATCH` route that
makes `updated_at` meaningful has existed since Phase 4. Mutability is the test, and
categories pass it.

### `inventory_transactions` stays create-only — this phase must not "complete the set"

The single most important non-change in this phase. `inventory_transactions` will still
have `created_at` and no `updated_at` when Phase 7 ships. BR-051 makes the row
immutable; there is no update path that could ever move an `updated_at`; adding one
would plant a column whose entire contract is "this value is a lie, it always equals
`created_at`." The existing entity comment explaining the absence is load-bearing
documentation and stays verbatim — and the convention note in §4 cites this table as
the worked example of the create-only case, so that the absence reads as a decision to
the next reader instead of looking like the gap `users` and `categories` were.

This is the phase's version of the discipline every prior plan showed: Phase 5 refused
to lock adjustments "for symmetry," Phase 6 refused a user-delete endpoint "to match
products." Here, symmetry with the other four tables is explicitly *not* the goal;
matching each table's own mutability is.

### `occurredAt` vs `created_at` — the distinction that already exists, named at last

`inventory_transactions` carries two times that are easy to conflate and this phase is
the right moment to write down the difference, because `users` and `categories` are
about to get the second kind and have none of the first:

- **`occurred_at`** (`timestamptz`, user-supplied, cannot be in the future per BR-052) —
  *when the stock movement happened in the world.* A business fact. It can be backdated
  to record yesterday's delivery.
- **`created_at`** (`TIMESTAMP DEFAULT now()`, server-set, never user-supplied) — *when
  the row was written to the database.* An audit fact. It can never be backdated and has
  no business meaning.

`users` and `categories` have no business-event time at all — there is no "when did this
account come into existence in the world" separate from "when was the row inserted" — so
they get only the audit kind. This is why the new columns are `created_at`/`updated_at`
and specifically **not** anything user-settable: a `CreateUserDto` that accepted a
`createdAt` would be conflating the two categories the transaction table keeps separate.
The DTOs already reject unknown fields (`whitelist: true, forbidNonWhitelisted: true`),
so a client sending `createdAt` gets a `400` — but the reason it should is worth the
sentence.

### `TIMESTAMP`, not `timestamptz`, to match the audit columns that already exist

`products.created_at`, `suppliers.created_at`, and `inventory_transactions.created_at`
are all plain `TIMESTAMP NOT NULL DEFAULT now()`. Only `occurred_at` — the business
date — is `timestamptz`. The new `users` and `categories` columns follow the audit
convention, not the business-date one: plain `TIMESTAMP`, so the schema stays internally
consistent and a future `find one migration that's different` audit turns up nothing.

There is a real argument that *all* server timestamps should be `timestamptz` and that
the existing plain `TIMESTAMP` audit columns are the latent bug. That argument is not
wrong, but it is a **separate, schema-wide** decision that would touch three existing
tables' columns and their migrations, and making it as a side effect of adding two
tables' worth of columns is exactly the kind of rider these plans reject. It is recorded
in §7 as a deliberately-deferred question, not silently resolved by making the two new
columns disagree with their four siblings.

### `@CreateDateColumn` / `@UpdateDateColumn`, not hand-managed columns

TypeORM's `@CreateDateColumn` sets the value on insert and `@UpdateDateColumn` bumps it
on every `save()` of a managed entity, from the application side, while the migration's
`DEFAULT now()` covers rows written by anything that bypasses the ORM (the raw
`INSERT`s in the e2e specs, a manual `psql` row). `Product` and `Supplier` already work
exactly this way; `User` and `Category` adopt the identical declarations so there is one
pattern in the codebase, not two. No service code changes — `UsersService.update`,
`CategoriesService.rename`, and friends already go through `repository.save`, which is
what triggers the `@UpdateDateColumn` bump; the columns start working the moment the
entity declares them.

One nuance to verify rather than assume (see §5): a partial update that goes through
`save()` on a loaded entity bumps `updated_at`; a `QueryBuilder` `.update()` that some
services occasionally use does **not**, because it never loads the entity. The Phase 6
`UsersService` methods and the `CategoriesService` rename both use the repository
`save`/`preload` style, so this is fine as written — but it is the one way an
`updated_at` could silently fail to move, so the tests assert it actually moves.

### The migration is add-with-default; no add-then-constrain dance is needed

`AddUserStatus` had to do the nullable → backfill → `SET NOT NULL` two-step because its
column had no sensible universal default at insert time and it wanted `NOT NULL`. Audit
timestamps are simpler: `DEFAULT now()` *is* the backfill. A single
`ADD COLUMN "created_at" TIMESTAMP NOT NULL DEFAULT now()` gives every pre-existing row
the migration-run time and every future row the insert time, in one statement, with no
window where the column is nullable. Existing seeded users and categories get a
`created_at` of "whenever you ran the migration," which is imprecise but honest — the
system genuinely does not know when those rows were first written, and inventing a
value would be worse than admitting `now()`.

This mirrors precisely how `products.created_at` and `suppliers.created_at` were born in
`InitSchema` (`NOT NULL DEFAULT now()`), so the two late tables end up with columns that
are indistinguishable from the two that had them from the start.

### `DEFAULT now()` is what keeps the existing tests untouched — the same lesson as Phase 6

This is the `AddUserStatus` reasoning applied one table over. Every e2e spec that seeds a
user does it with a raw `INSERT INTO users (name, role, email, password_hash) …` that
names no timestamp columns — `app.e2e-spec.ts`, `auth.e2e-spec.ts`,
`categories.e2e-spec.ts`, `roles.e2e-spec.ts`, and `users.e2e-spec.ts`. Any category
seeded by a raw `INSERT INTO categories (name) …` is the same. Because both new columns
are `NOT NULL DEFAULT now()`, none of those inserts mention them and none of them break.
Without the default, all of them break at once on a `NOT NULL` violation — the identical
failure mode Phase 6 called out, and the identical reason it doesn't happen.

### No `updated_at` bump on child writes bleeding up to parents

A subtle correctness point worth stating so nobody "fixes" it later. Recording a
transaction against a product must **not** touch that product's `updated_at`. `updated_at`
means "this product's own fields were edited" (name, SKU, threshold, status), not "some
child row referenced it." TypeORM only bumps `@UpdateDateColumn` when the entity itself
is `save()`d, so the default behavior is already correct — a stock-in saves an
`InventoryTransaction`, never the `Product` — and no cascade or `@RelationId` touch
should be added that would change that. The same holds for a user: recording a
transaction as user X does not modify user X. This phase adds columns; it must not add
the coupling that would make them lie.

### Nothing user-settable, nothing removable, and these columns are not authorization-relevant

`created_at` and `updated_at` are readable by anyone who can read the row and settable by
no one. They carry no access-control weight: unlike `users.status` (which stops a login)
or `users.role` (which gates a route), a timestamp gates nothing, so there is no guard,
no DTO, and no service branch touching them. They ride the existing serialization and the
existing role rules for their table — a `GET /users` is already Owner-only (BR-074), so
its new timestamps inherit that; a `GET /categories` is open to both roles, so its new
timestamps are too. This is the cheapest possible column, and the plan says so explicitly
because the temptation with any new field is to find a policy for it, and this one has
none.

---

## 2. What's new (backend)

### `User` gains audit columns

```ts
@CreateDateColumn({ name: 'created_at' })
createdAt: Date;

@UpdateDateColumn({ name: 'updated_at' })
updatedAt: Date;
```

The identical declarations `Product` and `Supplier` already carry. `passwordHash` keeps
its `@Exclude()`; the two new columns are **not** excluded — they are safe to serialize,
and `Product`/`Supplier` already expose theirs. Note the downstream reach: `User` is
embedded as `recordedBy` on every transaction read, so after this phase each nested
`recordedBy` also carries `createdAt`/`updatedAt`. That is harmless metadata (no secret,
no `passwordHash`), consistent with the nested `product`/`supplier` objects already
carrying theirs, and is asserted-not-assumed in §5 only to the extent that `passwordHash`
still doesn't leak.

### `Category` gains audit columns

The same two columns, and the "simplest possible entity" comment is updated rather than
left to rot — it becomes "the simplest entity that still follows the audit-timestamp
convention (§ domain-model)," so the comment stops contradicting the code.

### `inventory_transactions` — no change

Called out explicitly in the diff review: reviewers will expect an `updated_at` to
appear here "for consistency," and the correct review outcome is to confirm its
*absence*. The entity comment explaining why stays exactly as it is.

### New migration `…-AddAuditTimestampsToUsersAndCategories.ts`

Any timestamp sorting after `1787380000000-AddUserStatus` (e.g. `1787470000000`).

```
up:
  ALTER TABLE "users"      ADD COLUMN "created_at" TIMESTAMP NOT NULL DEFAULT now()
  ALTER TABLE "users"      ADD COLUMN "updated_at" TIMESTAMP NOT NULL DEFAULT now()
  ALTER TABLE "categories" ADD COLUMN "created_at" TIMESTAMP NOT NULL DEFAULT now()
  ALTER TABLE "categories" ADD COLUMN "updated_at" TIMESTAMP NOT NULL DEFAULT now()

down:
  ALTER TABLE "categories" DROP COLUMN "updated_at"
  ALTER TABLE "categories" DROP COLUMN "created_at"
  ALTER TABLE "users"      DROP COLUMN "updated_at"
  ALTER TABLE "users"      DROP COLUMN "created_at"
```

No `CREATE TYPE`, no backfill statement, no `SET NOT NULL` step — `DEFAULT now()` does
all of it in the `ADD COLUMN`. A header comment records why this migration is a single
step where `AddUserStatus` was four (a default that is also a valid backfill), and why
the columns are plain `TIMESTAMP` (match the existing audit columns, §1).

### No DTO, service, controller, or guard changes

There are none to make. No route reads or writes these columns explicitly; no request
body carries them (and the global `ValidationPipe` rejects one that tries); no role rule
mentions them. `UsersService` and `CategoriesService` already persist through
`repository.save`/`preload`, so `@UpdateDateColumn` bumps for free. This emptiness is a
feature of the design, not a gap in the plan.

### `run-seed.ts` — no change

The seed creates users and categories through `repository.create`/`save`, so
`@CreateDateColumn` sets both new columns automatically; it neither needs nor should
pass explicit timestamps (that would be the `occurredAt`-style user-supplied value the
convention forbids for audit columns). The one honest consequence: every seeded row's
`created_at` is "seed run time," identical across the batch — which is correct, since the
demo dataset genuinely has no real creation history. Left as-is.

---

## 3. Frontend changes

Deliberately minimal, and the boundary is worth drawing because Phase 6 §7 pre-labeled
the UI half of this as "a nice column on a screen, not a requirement."

**In scope — surface what the data now supports, where a detail view already exists:**

- **The Owner-only user screen** — Phase 6 shipped `Views.userList` and `Views.userForm`
  (and did not build a separate `Views.userDetail`), so the natural home is the edit view
  (`Views.userForm` in edit mode): an "Added *date*" line and, when `updatedAt` differs
  meaningfully from `createdAt`, a "Last updated *date*" line, read-only, using the same
  date formatter the transaction history already uses. If a `userDetail` view is added
  later, the lines move there; the render helper is the same. This is the one place the
  timestamps answer a question an Owner actually asks ("when did I set this account up /
  when did this last change").
- **`Views.supplierDetail` and `Views.productDetail`** may get the same two lines — the
  data has been there since InitSchema and was simply never shown. This is optional
  polish, not required for the phase to be done; if included it is one shared render
  helper, not three copies.

**Out of scope — explicitly:**

- No "Created" / "Updated" **columns in list views.** A timestamp per row in a table is
  noise for a 1–10-person single-location business (A-1) that is scanning for stock
  health, not audit trails. Detail views are where a single row's provenance belongs.
- No sorting or filtering by timestamp. That is a reporting feature (see the Reporting
  direction still on the Future list), and inventing a sort control here would smuggle in
  the start of one.
- No relative-time formatting ("3 days ago") or live-updating clocks. Absolute dates,
  the same format already in use.

If the owner would rather ship this phase as **backend-only** — the columns and the
documented convention, with zero UI — that is a coherent stopping point too, since the
headline change is the data-model consistency and everything in this section is
presentation. Flagged here as the one real scope fork in the phase.

---

## 4. Documentation updates

1. **`domain-model.md`** — a new short **"Audit timestamps"** subsection, the canonical
   home for the convention this phase writes down:
   - Every table records `created_at` (server-set on insert, never user-supplied).
   - A table whose rows can change also records `updated_at` (bumped on every entity
     `save`); a table whose rows are immutable does not.
   - `inventory_transactions` is the worked example of the immutable case: `created_at`
     only, because BR-051 forbids editing a recorded transaction — its missing
     `updated_at` is a consequence of the immutability rule, not a gap.
   - The `occurred_at` vs `created_at` distinction (§1): business-event time
     (`timestamptz`, backdatable, BR-052-bounded) vs row-write time (`TIMESTAMP`,
     `now()`, never backdated). `users` and `categories` have only the second kind.

2. **`business-rules.md`** — **no new BR is invented**, but **BR-051** (immutability)
   gains one sentence noting that the *absence* of `updated_at` on
   `inventory_transactions` is a direct consequence of it, so the schema and the rule
   cross-reference each other. This is the honest placement: "rows record when they were
   written" is a data convention documented in `domain-model.md`, not a business rule
   about stock; the only genuine *rule* in play is the immutability that BR-051 already
   states.

3. **`architecture-observations.md`** — a note that the audit-timestamp convention is now
   uniform and where it is defined, so the file that catalogues cross-cutting structure
   mentions it. (This is where the "all-`timestamptz`" deferral from §7 is also parked as
   a known latent question.)

4. **`api.md`** — title bumped to Phase 7. A line in the preamble stating that every
   resource response includes `createdAt`, and every **mutable** resource
   (`users`, `products`, `suppliers`, `categories`) additionally includes `updatedAt`,
   while `inventory_transactions` responses include `createdAt` only (with the
   `occurredAt`-vs-`createdAt` distinction spelled out once, since a client will see both
   on a transaction and must not confuse them). No per-route table changes — the columns
   ride every existing route's existing response shape and role.

5. **`requirements.md`** — a single honest line, not a new FR: audit timestamps are a
   data-model consistency change with no user-facing requirement behind them, so no FR is
   added; the capability they *enable* (showing "added on" / "last updated") is noted as
   available to future UI work but is not itself a tracked requirement. Recording the
   *absence* of an FR, with the reason, keeps the requirements table from being quietly
   inflated — the same discipline Phase 6 used when it marked FR-063/064 "Should, not
   Must."

6. **`product.md`** — the Phase 6 §7 bullet that named this work is marked done by
   pointing at this phase; nothing in §7's Future list or the open questions (Q-4, Q-6,
   Q-7) is resolved by it, and that is stated so the phase isn't misread as closing a
   product question.

7. **`docs/learning-notes/`** — a short addition to **`database-access.md`** (which
   already covers entities and columns) rather than a new file: what `@CreateDateColumn`
   / `@UpdateDateColumn` do, that the DB `DEFAULT now()` is what covers non-ORM inserts
   (the e2e specs' raw SQL), and the one trap — a `QueryBuilder` `.update()` skips the
   `@UpdateDateColumn` bump because it never loads the entity, so `updated_at` only stays
   honest as long as writes go through `save`/`preload`.

8. **`README.md`** — Current phase section updated; no sign-in-table change (the demo
   users are unchanged). Optionally a line that user/supplier/product detail views now
   show creation and last-updated dates, only if §3's UI half ships.

---

## 5. Testing plan

The behavior added here is small, but two of its properties are easy to get silently
wrong (an `updated_at` that never moves; a raw-SQL insert that breaks), so both get a
pinning test.

- **Unit — `users.service.spec.ts`** (extended): after `update` changes a field, the
  returned entity's `updatedAt` is **strictly greater** than its `createdAt` — the
  assertion that catches a `QueryBuilder`-style write that forgot to bump. Because the
  bump has sub-second granularity and a mocked repository doesn't run real DB triggers,
  this is better verified at the e2e layer against a real Postgres (below); the unit test
  asserts the narrower, mock-friendly fact that `update` calls `save`/`preload` (the path
  that bumps) and not `.update()` (the path that doesn't).

- **E2E — `users.e2e-spec.ts`** (extended, real Postgres):
  - `GET /users/:id` includes `createdAt` and `updatedAt`; both are valid ISO strings.
  - **Create-then-edit moves `updatedAt` and leaves `createdAt` fixed.** Create a user,
    record `createdAt`/`updatedAt` (equal at creation), `PATCH` a field after a
    perceptible delay, and assert `createdAt` is unchanged while `updatedAt` is now
    later. This is the one test that proves the column is live rather than decorative;
    without the delay it can flake on equal timestamps, so it either waits briefly or
    asserts `updatedAt >= createdAt` plus "changed from the original `updatedAt`."
  - `passwordHash` still appears in **no** response, including the newly-timestamped user
    objects and the nested `recordedBy` on a transaction read — re-asserted here because
    this phase touches the `User` serialization surface, even though it doesn't change the
    exclusion.

- **E2E — `categories.e2e-spec.ts`** (extended): `GET /categories` items include
  `createdAt`/`updatedAt`; renaming a category via `PATCH /categories/:id` moves
  `updatedAt` and not `createdAt`.

- **E2E — `inventory` / transactions** (extended or asserted in an existing spec): a
  transaction response includes `createdAt` and **does not** include `updatedAt` — the
  test that pins the deliberate non-change and would fail loudly if someone "completed the
  set" by adding an `@UpdateDateColumn` to the transaction entity. Also assert that
  recording a stock-in against a product does **not** change that product's `updatedAt`
  (§1's no-bump-from-children property): read the product's `updatedAt`, record a
  transaction, read it again, assert equal.

- **Existing suites — must pass untouched.** The `DEFAULT now()` on all four new columns
  is exactly what keeps every raw `INSERT INTO users (…)` and `INSERT INTO categories (…)`
  in the five existing e2e specs compiling and passing without edits. This is the
  regression the phase is most likely to cause and most cheaply prevents; the rollout
  (§6) runs the full suite immediately after the migration precisely to confirm it.

- **No new integration-layer test** — consistent with Phases 3–6. Nothing here is
  concurrency-sensitive database behavior a mocked repository would misrepresent; the two
  facts that need a real database (the `updated_at` bump, the raw-insert compatibility)
  are covered at the e2e layer where a real Postgres runs.

---

## 6. Rollout order

1. **Migration + `User` and `Category` entity columns**, together, then **run the full
   suite with zero test changes.** The columns exist, the ORM manages them, and the
   `DEFAULT now()` should keep every existing raw-SQL insert green. If anything in the
   existing suite goes red here, the default or the column type is wrong, and finding out
   before any assertion depends on the columns costs nothing. This is the whole backend
   behavior change — everything after it is tests and presentation.
2. **New assertions** in `users.e2e-spec.ts`, `categories.e2e-spec.ts`, and the
   transaction spec (§5), including the two "non-change" tests (transaction has no
   `updated_at`; a child write doesn't bump the parent).
3. **Frontend detail-view lines** (§3), if the UI half is in scope. Skippable as a unit
   if the owner chose backend-only.
4. **Documentation** (§4) — the convention note in `domain-model.md` is the deliverable
   that outlasts the code, so it is not optional even in the backend-only cut.

Step 1 is the only step that touches runtime behavior, and it is a strict superset-add
(new columns, nothing removed or altered), so it is safe to ship on its own; steps 2–4
can follow without a client ever seeing an intermediate broken state.

---

## 7. Explicitly out of scope for Phase 7 (Future)

- **`updated_at` on `inventory_transactions`** — not a deferral, a permanent non-feature.
  BR-051 makes the row immutable; there is no write path to move the column. Listed here
  only because its absence is the thing a reviewer is most likely to flag as missing.
- **Migrating the existing `TIMESTAMP` audit columns to `timestamptz`** — a real,
  arguable, schema-wide change (three existing tables plus the two new ones) that this
  phase deliberately does not make, so the two new columns match their four existing
  siblings rather than starting a second convention mid-schema. Parked in
  `architecture-observations.md` as a known question, not resolved by adding columns.
- **`created_by` / `updated_by` (who, not just when)** — attribution of *administrative*
  changes is the "who deactivated whom, when" audit-log feature Phase 6 §7 already scoped
  as a genuinely different phase: a new table and a write path on every admin action, not
  two timestamp columns. `created_at`/`updated_at` answer *when*; they intentionally do
  not answer *who*.
- **An administrative audit log / change history** — same as above; recording the
  sequence of changes to a row is a separate feature from stamping its latest change.
- **Surfacing timestamps in list views, sorting, or filtering by them** — §3; that is the
  start of the Reporting/analytics direction still on `product.md`'s Future list, not part
  of this one.
- **Relative-time formatting, timezones-in-UI, "last seen / last login"** — `last_login`
  in particular is a genuinely different column with its own write path (stamped on
  authentication, not on edit) and is not an audit timestamp of the row; out of scope.
- **Soft-delete `deleted_at` timestamps** — this system deactivates rather than deletes
  (BR-004, BR-076); there is no soft-delete pattern to timestamp, and adding one would
  presuppose a delete model the product has deliberately avoided.

---

## 8. Definition of done

- [x] `users` and `categories` each have `created_at` and `updated_at` as
      `TIMESTAMP NOT NULL DEFAULT now()`, added in one migration that needs no backfill
      or `SET NOT NULL` step, and every one of the five existing e2e specs' raw
      `INSERT`s still compiles and passes untouched.
- [x] `User` and `Category` carry `@CreateDateColumn`/`@UpdateDateColumn` identical to
      `Product`/`Supplier`; editing a user or renaming a category moves `updated_at` and
      leaves `created_at` fixed, proven by an e2e test against a real database.
- [x] `inventory_transactions` still has `created_at` and **no** `updated_at`, with a
      test asserting the transaction response omits `updated_at`, and recording a
      transaction does not bump the referenced product's `updated_at`.
- [x] `passwordHash` appears in no response, including the newly-timestamped user objects
      and nested `recordedBy` — re-asserted.
- [x] No new FR, DTO, service branch, controller route, or guard was added; the columns
      are read-only, user-unsettable, and authorization-irrelevant.
- [x] `domain-model.md` documents the audit-timestamp convention (created-always,
      updated-if-mutable, transactions as the immutable example, `occurred_at` vs
      `created_at`); `business-rules.md` BR-051 notes the immutability→no-`updated_at`
      link; `api.md` (Phase 7), `architecture-observations.md`, `requirements.md` (the
      no-FR note), `product.md`, `README.md`, and `database-access.md` all reflect the
      phase.
- [x] If the UI half shipped: user (and optionally supplier/product) detail views show
      creation and last-updated dates; no list-view columns, sorting, or filtering were
      added. If it did not: the backend columns and the documented convention stand on
      their own.
- [x] Full backend suite green: unit, integration, and all e2e specs.
