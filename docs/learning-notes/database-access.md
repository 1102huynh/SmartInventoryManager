# Database Access: Entities, Repositories, Migrations

## Concept

**TypeORM** maps TypeScript classes ("entities") to database tables via decorators.
An entity like `backend/src/products/product.entity.ts` describes columns, types,
and relations; TypeORM uses that description two ways: to generate a
**Repository** (a typed object with `find`/`save`/`delete`/query-builder methods) and
to generate **migrations** — reviewable SQL files that bring a real database's schema
in line with what the entities describe.

## Why NestJS uses it

Two reasons this project leans on it: type safety (a `Repository<Product>` only
accepts fields `Product` actually has) and a clean separation between *how* data is
stored and *how* it's used — a service calls `repository.find({ where: {...} })`
without writing SQL, and swapping the underlying database driver wouldn't change a
single line of service code.

## How it works in this project

Every entity in `backend/src/*/​*.entity.ts` is registered with
`TypeOrmModule.forFeature([Entity])` in its module, which is what makes
`@InjectRepository(Entity)` resolvable in a constructor. Schema changes never happen
automatically (`synchronize: false` — see `database/database.module.ts`); they go
through `npm run migration:generate` / `migration:run`, producing files like
`database/migrations/1787122164465-InitSchema.ts` that are plain, readable SQL a
human can review before it ever touches a real database.

## Example

`InventoryTransaction`'s schema (`backend/src/inventory/inventory-transaction.entity.ts`)
uses `@Check(...)` decorators to push three business rules down into the database
itself, as a second line of defense behind the DTO/service validation:

```ts
@Check(`"quantity_delta" <> 0`)
@Check(`type = 'stock_in' OR supplier_id IS NULL`)
@Check(`type <> 'adjustment' OR (reason IS NOT NULL AND reason <> '')`)
```

Even a bug that bypassed `InventoryService` entirely couldn't produce a row violating
these — Postgres itself refuses the insert.

## Audit timestamps: `@CreateDateColumn` / `@UpdateDateColumn`

`Product`, `Supplier`, `User`, and `Category` (as of Phase 7,
`docs/phase-7-plan.md`) all declare:

```ts
@CreateDateColumn({ name: 'created_at' })
createdAt: Date;

@UpdateDateColumn({ name: 'updated_at' })
updatedAt: Date;
```

`@CreateDateColumn` sets the value once, on insert. `@UpdateDateColumn` bumps it on
every `save()` of a managed (loaded) entity. Both are application-side — TypeORM sets
them before issuing the `INSERT`/`UPDATE` — so anything that writes a row *without*
going through the ORM (a raw `INSERT` in an e2e spec's `beforeEach`, a manual `psql`
row) would get no value from these decorators at all. That's what the migration's own
`DEFAULT now()` covers: it's a second, database-level source for the same value,
there specifically so a non-ORM insert still ends up with a sensible timestamp
instead of a `NOT NULL` violation. See `docs/domain-model.md` §8 for which tables get
which column(s) and why.

**The one trap — corrected 2026-08-24, Phase 8, by an e2e test that failed and
proved it wrong**: the folklore (repeated in this file until now) is that a
`QueryBuilder` `.update()` — including `repository.update()`, which builds one
internally — skips `@UpdateDateColumn` because it never loads the entity into
memory. **That's backwards.** `UpdateQueryBuilder` (`typeorm/query-builder/`
`UpdateQueryBuilder.js`) unconditionally appends
`SET "updated_at" = CURRENT_TIMESTAMP` to *any* update whose target columns don't
already include the update-date column — `repository.update()` bumps it exactly
the way `repository.save()` does, with no entity load required. The folklore is
true for `@BeforeUpdate()`-style *listeners/subscribers*, which genuinely don't run
on a `QueryBuilder` update; it is false for this one piece of column metadata,
which `UpdateQueryBuilder` treats specially and populates itself.

**The actual way to keep a write from moving `updated_at`**: TypeORM only
auto-populates the update-date column when it's *absent* from the values you pass
to `.update()`/`.set()` — include it yourself, with its own current, unchanged
value, and your value wins instead of `CURRENT_TIMESTAMP`. `UsersService.persistLoginState`
(Phase 8, `docs/phase-8-plan.md`) does exactly this: a failed login attempt writes
`failedLoginAttempts`/`lockedUntil` via `repository.update()` and *also* passes
`updatedAt: user.updatedAt` (the value already sitting on the loaded entity) to pin
it, because a stranger who never authenticated as anyone must not be able to move a
column that's supposed to mean "this row's own fields were edited." Discovered the
hard way — the first version of that code passed only the two changed columns,
assumed `.update()` alone was enough, and an e2e test asserting `updatedAt` hadn't
moved failed against a real database.

`UsersService.update`/`setStatus`/`setPassword` and `CategoriesService.update` are
unaffected by any of this — they use `repository.save()` on a loaded entity, which
is supposed to bump `updated_at`, and does.

## `timestamp` vs. `timestamptz` (Phase 10)

`Product`, `Supplier`, `User`, `Category`, `InventoryTransaction`, and `AuditEvent`
all declare their timestamp columns as `type: 'timestamptz'` now
(`docs/phase-10-plan.md`). Before that, every one of them except
`InventoryTransaction.occurredAt` was `type: 'timestamp'` — the difference is one
type parameter, and it's worth understanding what it actually buys, because on this
project's own dev machine it buys nothing observable.

**A `timestamp without time zone` stores a clock reading, not an instant.** Postgres
keeps exactly the digits it's given — year, month, day, hour, minute, second — and
records no zone alongside them. `2026-08-25 15:50:04` means nothing on its own; it
means something only once you know *which clock* wrote it. A
`timestamp with time zone` (`timestamptz`) stores an actual instant: internally,
Postgres converts whatever it's given to UTC and keeps that, displaying it back
converted to whichever zone the current session is set to. Two sessions with
different `TimeZone` settings see the same `timestamptz` value formatted two
different ways; they see the same `timestamp` value as the same digits, correct or
not.

**What actually happens on write, measured rather than assumed — and "a TypeORM write"
turned out to mean two different things.** This section already documented, since
Phase 8, that `@CreateDateColumn`/`@UpdateDateColumn` don't hand `pg` a computed value
when the entity carries none of its own (the only way any service in this codebase uses
them): TypeORM emits the literal `DEFAULT` on `INSERT` and appends `CURRENT_TIMESTAMP`
to `UPDATE`, letting Postgres's own expression evaluator fill it in — see "Audit
timestamps" above. Filling this in from the *database* side means the value is computed
**in Postgres's session zone**, and coerced into a naive `timestamp` column as digits in
that zone, no different from a raw `DEFAULT now()`.

That is not the only way a `Date` reaches this schema, though. `UsersService
.registerFailedLogin`'s `user.lockedUntil = new Date(Date.now() + …)` is a value the
*application* computes, with no database default to defer to — so TypeORM has no
`DEFAULT`/`CURRENT_TIMESTAMP` to fall back on and must send the actual `Date` as a bound
parameter instead. `pg` serializes it into a text parameter carrying an explicit UTC
offset (`node_modules/pg/lib/utils.js`'s `dateToString`), so the value leaving Node
unambiguously identifies an instant — but a naive `timestamp` column has nowhere to put
that offset, so it's discarded and the digits kept are **Node's own local reading**, not
Postgres's session zone at all. (Into a `timestamptz` column, by contrast, the offset is
used directly and the instant is stored whatever either process's zone is.)

The consequence is the one that surprises people, and it applies specifically to the
`DEFAULT`/`CURRENT_TIMESTAMP` case: **a `@CreateDateColumn`/`@UpdateDateColumn` write and
a `DEFAULT now()` write land in exactly the same place**, both as digits in the session
zone, neither depending on Node's zone at all — while `locked_until`'s explicit-parameter
write depends on Node's zone and not the session zone. This is not a reading of the
driver's source alone — it is what the Phase 10 experiments measured, in two rounds:
`backend/src/database/timestamps.integration.spec.ts` pins Postgres's session zone
through `pg`'s `options: '-c timezone=<zone>'`, and with three different zones pinned,
the `categories.created_at` digits tracked each one exactly while Node's real zone never
moved — and a fourth run, reverting `users.locked_until` to plain `timestamp` under the
same pinned harness, left that column's round trip correct regardless, because its
digits had been tracking Node's zone the whole time, not the pinned one.

**What happens on read.** `pg`'s parser (`postgres-date`) mirrors it. A `timestamptz`
value arrives with its own offset attached, so the resulting `Date` is the right
instant regardless of either side's zone. A plain `timestamp` value arrives as bare
digits with no offset, and `postgres-date` builds the `Date` by treating them as
**local time in the reading process's own zone** — Node's. Nothing in the value says
which zone produced the digits, so nothing can correct for a difference.

**Why "the column has no zone, so it must be UTC by convention" is a convention
nothing enforces.** Put the two halves together for the `DEFAULT`/`CURRENT_TIMESTAMP`
columns — every `created_at`/`updated_at` in this schema — and the asymmetry is the
whole story: the digits are *written* in Postgres's session zone and *read* in Node's
zone. Those two are different settings on different processes, and the round trip is
correct only while they happen to be equal. Before Phase 10 they were equal, because
both processes run on one developer's machine (`tools/README.md`) — nothing checked it,
and nothing would have reported it breaking. `locked_until` doesn't share this
asymmetry — its write zone is Node's too, same as its read zone — so its own failure
mode is different, and narrower: not "the deployment's two zones disagree," but "Node's
own zone changed between the write and a later read" (a restart onto a differently-zoned
host, a DST transition).

Note what the `created_at`/`updated_at` failure would look like, because it is not what
the phase plan first predicted. It is not two rows disagreeing with each other — every
`DEFAULT`/`CURRENT_TIMESTAMP` write uses the same session zone, so the table stays
internally consistent and no comparison between rows would reveal anything. It is
*every* value in *every* one of these columns reading back shifted by the same offset,
uniformly and silently: the same digits either way, with nothing to distinguish a
shifted read from an honest one. A defect you cannot find by comparing your own data
against itself is a good argument for not storing the ambiguity in the first place.

**`ALTER COLUMN ... TYPE timestamptz USING ... AT TIME ZONE '<zone>'` is the one
place in this codebase's life where that assumption has to be written down and
defended.** Converting an existing naive column with no `USING` clause interprets
every value in the session's ambient `TimeZone` setting — silently reproducing the
exact unrecorded-assumption problem the conversion exists to fix. Naming the zone as
a literal (`docs/phase-10-plan.md`'s migration pins `SOURCE_ZONE = 'Asia/Ho_Chi_Minh'`)
forces a reviewer to either agree with a stated fact or object to it; the implicit
form asks the reviewer nothing and gets whatever the session happened to be set to.

One literal isn't automatically enough, either — a lesson this migration only needed
because of the write-path asymmetry above. Its ten audit columns and `locked_until`
were written by different zones (Postgres's session, Node's, respectively), so the
migration pins two constants, `SOURCE_ZONE` and `SOURCE_ZONE_NODE`, not one — equal on
this project only because one machine runs both processes, and kept separate in the
code specifically so a deployment where they differ has somewhere correct to say so.

**The generalizable lesson**, in the shape this file's other sections use: a type
that stores less than the value means has to be paid for by an agreement, and an
agreement between two processes that neither one checks is not a design — it is a
coincidence that has not failed yet.

**A second lesson, from how this section came to be right — twice.** Everything above
was originally written the other way round: that `pg`'s offset is discarded and the
digits stored are Node's own wall-clock, so the two writers would disagree with each
other whenever the machines' zones differed. It reads plausibly, it was believed long
enough to be written into a plan and five documents, and it was wrong. What corrected it
was not more careful reading — it was pinning the session zone three times and looking
at the digits.

That correction then overreached in its own way: having shown `@CreateDateColumn`
writes track the session zone, it was tempting to conclude every TypeORM-managed
timestamp does — including `locked_until`, the one column in this schema that is a
genuine application-computed parameter rather than a `DEFAULT`/`CURRENT_TIMESTAMP`
deferral. A single passing experiment on `categories.created_at` doesn't cover a
different column with a different write path, and it took a fourth run — reverting
`locked_until` itself under the same pinned harness — to find that it doesn't share the
exposure. **A generalization is only as wide as what was actually tested; the fix for
an unjustified generalization is to test the specific case, not to assume the opposite
generalization instead.** When a note in this folder explains a mechanism at the
driver/database boundary, prefer the version somebody has run an experiment against,
name which one, and don't extend it past the column that experiment covered without
running another. See `docs/phase-10-plan.md` §1 and §5 for how all three rounds were
tested, and `docs/learning-notes/testing-strategy.md`'s note on ambient dependencies.

## Common Mistakes

- Giving a nullable TypeScript field (`string | null`) a `@Column()` with no explicit
  `type:` — TypeORM can't infer a column type from a union, and errors with
  `Data type "Object" ... is not supported`. Every nullable column in this project's
  entities spells out `type: 'varchar'` / `'int'` explicitly for exactly this reason
  (see `supplier.entity.ts`).
- Turning on `synchronize: true` "just for now" and forgetting about it — it silently
  alters a database's schema (including dropping columns) on every boot, with no
  history and no chance to review the change. This project never enables it outside
  the dedicated test datasource (`database/test-data-source.ts`), where wiping the
  schema on every run is the entire point.
- Calling `repository.delete({})` to clear a table — TypeORM refuses an empty
  criteria object as a safety guard. The seed script (`database/seeds/run-seed.ts`)
  reaches past the repository API entirely for this — `manager.query('TRUNCATE
  TABLE ... RESTART IDENTITY CASCADE')` — which is the deliberate "yes, delete
  everything, and reset the id sequences too" escape hatch: a repository-level
  delete has no equivalent for `RESTART IDENTITY`, and `TRUNCATE ... CASCADE` also
  sidesteps having to delete child rows before parent rows by hand.

## Key Takeaways

- Entities describe the schema; migrations are the reviewable, reversible way schema
  changes actually reach a database.
- A Repository is a typed provider, injected like any other — see
  `dependency-injection.md`.
- Database `@Check` constraints are a legitimate second layer of enforcement, not a
  replacement for service-layer validation.
- Nullable primitive columns need an explicit `type:` — this bit every entity in this
  project the first time.
