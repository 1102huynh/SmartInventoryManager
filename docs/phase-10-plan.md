# Phase 10 Plan — Schema-Wide `timestamptz`

Status: Phase 10 — Done
Last updated: 2026-08-27 (three rounds of corrections below, made during implementation
and testing, not at planning time — the failure mechanism in §1 is not the one this plan
was written around, and neither was `users.locked_until`'s exposure; see §1's opening
note, §5's record of how each version was tested, and §1's `locked_until` bullet for how
that question was finally closed by experiment)
Scope decided with the project owner: **convert all eleven plain `TIMESTAMP` columns in
the schema to `timestamptz`, in one migration, and make the audit-timestamp convention
name a type** — and nothing else. Scoped the same way `phase-3-plan.md` was scoped to
authentication, `phase-5-plan.md` to authorization, `phase-6-plan.md` to user management,
`phase-7-plan.md` to audit timestamps, `phase-8-plan.md` to rate limiting and lockout, and
`phase-9-plan.md` to the audit log: one headline change, an explicit out-of-scope list, no
punch-list riding along.

## Why this phase, why now

This is the only remaining item deferred **by name** in *three consecutive phases*, and it
is the only one of them whose cost grows with every phase that defers it again.

Phase 7 §7 parked it, in the phase that created the convention:

> **Migrating the existing `TIMESTAMP` audit columns to `timestamptz`** — a real,
> arguable, schema-wide change (three existing tables plus the two new ones) that this
> phase deliberately does not make, so the two new columns match their four existing
> siblings rather than starting a second convention mid-schema.

Phase 8 §1 declined to reopen it and added `locked_until` as a plain `TIMESTAMP` for
exactly that reason ("starting a `timestamptz` island here is exactly the mid-schema second
convention Phase 7 §7 already refused to start"). Phase 9 §1 deferred it a third time and
did the one useful thing a deferral can do — it stopped counting in impressions and wrote
down the list:

> Eleven columns across six tables, up from ten across five before this phase. It has only
> grown, never shrunk, every phase since Phase 7 first parked the question.

Every one of those three deferrals gave the *same* reason, and it is a good one: **a
schema-wide change should not ride along as a side effect of adding columns to two tables,
or a lock counter, or an audit table.** That reason does not argue against making the
change. It argues that the change needs a phase of its own — which is the same shape of
argument Phase 9 §1 made about itself ("nothing about the system changed to make this newly
necessary; what changed is that the deferral reasoning ran out"). This is that phase.

Two things make *now* the right time rather than later:

- **The list stopped growing for the first time.** Phase 9 added exactly one column
  (`audit_events.created_at`) and, unlike Phases 7 and 8, added no table that is likely to
  grow more. Every phase that ships before this one makes the migration wider and the
  conversion slower; this is the narrowest the schema is going to be for a while.
- **Phase 9 put a timestamp column on the login hot path and then indexed it.**
  `audit_events.created_at` is written on every authentication attempt in the system and
  carries `IDX_audit_events_created_at` for the `days` filter. It is the first plain
  `TIMESTAMP` column in this project that both grows without a user acting (Phase 9 §1) and
  is read through a range query. A range query over a column whose meaning depends on an
  unstated agreement between a writing zone and a reading zone is a worse thing to own than
  four `created_at` columns nobody filters on.

One framing makes the whole phase coherent and is worth stating before any decision: **a
`timestamp without time zone` column does not store a moment in time. It stores a reading
off a clock, and it does not record which clock.** Everything this project currently gets
right about its timestamps is correct because the zone the digits are written in and the
zone they are read back in happen to coincide, and nothing anywhere checks that they do.
`architecture-observations.md` has said as much since Phase 7 — "the current plain
`TIMESTAMP` columns are implicitly server-local/UTC by convention, not by an enforced type"
— without naming which zones those are or what happens when they diverge. §1 names them.

---

## 1. Design decisions

### The write zone is not the read zone, and the precondition nobody checks

This is the sharpest line in the phase, and it has to come first because every other
decision follows from it.

> **[Corrected during implementation, §5 — twice, and the second correction was itself
> incomplete until a third round settled it]** This section originally argued the defect
> was *two writers disagreeing with each other* — `DEFAULT now()` stamping the Postgres
> server's wall-clock while TypeORM stamped Node's. Building the test meant to prove that
> disproved it: comparing an `@CreateDateColumn` write against a `DEFAULT now()` write
> showed them always agreeing, on a converted schema and a reverted one alike. The
> correction that followed swung too far the other way — "TypeORM's parameterized
> `INSERT`" is not one mechanism, and treating it as one is exactly what produced the
> wrong generalization. Tracing the actual SQL settled it (§5): the two writers agree
> because `@CreateDateColumn`/`@UpdateDateColumn` **are** `DEFAULT`/`CURRENT_TIMESTAMP`
> under the hood, not because every TypeORM-managed column shares that path. A plain
> `@Column` holding a value the application assigns itself — the one case in this schema
> being `locked_until` — is genuinely different, and the corrected mechanism below says so.

**A plain `timestamp` column stores digits with no zone marker, and which zone produced
them depends on *how the value reached the column* — not on whether TypeORM was
involved.**

- **Deferred to the database — the audit columns' path.** `@CreateDateColumn` on insert
  and `@UpdateDateColumn` on update never hand `pg` a computed `Date` in this app: when
  the entity carries no value for that field (the only way any service in this codebase
  uses them), TypeORM emits the literal `DEFAULT` on `INSERT` and appends
  `CURRENT_TIMESTAMP` to `UPDATE` — see `docs/learning-notes/database-access.md`'s
  pre-existing note on exactly this mechanism, there since Phase 8. Those are Postgres
  expressions, evaluated **in Postgres's session zone**, indistinguishable at the SQL
  level from a raw `DEFAULT now()` — which is why every `created_at`/`updated_at` column
  in the schema, `DEFAULT now()` in a raw insert, and every row `npm run seed` writes
  without naming a timestamp column, all land in the same place. Verified by pinning
  three different session zones and watching the stored digits track each one exactly,
  independent of Node's real zone (§5).
- **Sent as an explicit parameter — `locked_until`'s path, and its only occurrence in this
  schema.** `UsersService.registerFailedLogin`'s `user.lockedUntil = new Date(Date.now() +
  …)` is an application-computed value with no database default to defer to, so TypeORM
  hands `pg` the actual `Date` object as a bound parameter. `pg` serializes it with an
  offset (`dateToString`); a naive column has nowhere to put that offset, so it is
  discarded and the digits kept are **Node's own local reading** — not Postgres's session
  zone. Verified the same way: pinning Postgres's session zone three different ways left
  this column's stored digits unchanged, tracking only Node's real zone.
- **The read side, identical for both.** `pg`'s `postgres-date` receives bare digits with
  no offset attached and builds a `Date` by treating them as local time in **the reading
  process's** zone — Node's. Nothing in the value says which zone produced it, so nothing
  can correct for the difference.

The audit columns' write zone (Postgres's session) and read zone (Node's) are different
settings on different processes whenever the deployment doesn't force them equal — an
everyday, standing condition, not something that has to change over time. `locked_until`'s
write zone and read zone are **both Node's**, at two different moments — equal as long as
Node's own zone doesn't move between them, which is a narrower and less constantly-present
risk (§1's `locked_until` bullet below has the full argument).

On this project today those two zones coincide: `tools/README.md` describes a portable
Postgres 17.6 running on `127.0.0.1:55432` on the developer's own machine, alongside the
Node process, both at UTC+7. Write zone equals read zone — so the columns round-trip
perfectly and every ISO string the API emits is correct.

**Nothing enforces that, nothing tests it, and nothing would report it if it stopped being
true.** The ordinary way it stops being true is not exotic: Postgres in a container (UTC by
default) with Node on the host, or the reverse. In that arrangement *every* naive timestamp
in the database — no matter which writer produced it — reads back shifted by the offset
between the two zones, uniformly and invisibly. There is no column, no flag, and no way
after the fact to tell a shifted row from an honest one, because they are the same digits.
The rows all look fine. This is the same category of defect Phase 9 §1 fork A named for
`req.ip` behind an unconfigured proxy: **wrong data that looks like a real signal, which is
worse than no data.**

Worth noting what the corrected mechanism costs and what it buys. It is *narrower* in one
respect — there is no scenario in which two rows in the same column disagree with each
other, so the database is never internally inconsistent. It is *broader* in the respect
that matters: the corruption is not a rare collision between two write paths but a uniform
shift applied to every read, which means it cannot be spotted by comparing rows and will
not announce itself in any way.

`timestamptz` removes the precondition rather than documenting it. Postgres stores an
instant; the `pg` driver reads an instant; `new Date()` is an instant. Writer and reader
converge on the same value whatever either process's zone is set to, because the zone stops
being part of the stored value at all.

### What this phase buys is not a value — it is a guarantee

Worth stating plainly, because the opposite claim is the easy one to make and it would be
false: **on a single-zone deployment this migration changes no value the API returns.**

The `pg` driver already builds a JS `Date` from a naive `timestamp` by interpreting it in
Node's local zone; if the migration interprets the same stored values in that same zone
(§ below), the resulting instants are identical to the ones the driver was already
producing. `JSON.stringify` serializes both through `toISOString()`. Every timestamp string
in every response is byte-for-byte what it was before.

So this phase adds no capability, no route, no field, and no user-visible behavior. It is
the third phase in a row about which that can be said, and — like Phase 7's audit columns
and Phase 8's throttle — the honest thing is to say what it *does* buy: the same output now
survives Node and Postgres disagreeing about a zone, which today it would not. That is a
guarantee, not a feature, and §5 is built around the awkward consequence: **the existing
test suite cannot tell before from after.** Only a test that forces the two zones apart can,
which is why the phase has exactly one genuinely new test and why that test is its headline.

### Which columns — all eleven, including the one that is not an audit column

The list, from `architecture-observations.md`'s Phase 9 count, unchanged since:

| Table | Columns | Added by |
|---|---|---|
| `products` | `created_at`, `updated_at` | `InitSchema` |
| `suppliers` | `created_at`, `updated_at` | `InitSchema` |
| `inventory_transactions` | `created_at` | `InitSchema` |
| `users` | `created_at`, `updated_at` | Phase 7 |
| `categories` | `created_at`, `updated_at` | Phase 7 |
| `users` | `locked_until` | Phase 8 |
| `audit_events` | `created_at` | Phase 9 |

Eleven columns, six tables. One column is deliberately *not* on the list because it is
already right: **`inventory_transactions.occurred_at` has been `timestamptz` since
`InitSchema`** and this phase does not touch it.

**`users.locked_until` is included, and that is a decision rather than a sweep.** Phase 8's
migration comment is explicit that it is not an audit column — "operational state, not a
record of when something happened" — and that it followed the audit convention only to avoid
starting a second one mid-schema. It converts here for two reasons, one inherited and one
of its own:

- The inherited reason is the same one Phase 8 gave in the other direction: whatever the
  convention is, this column follows it. Leaving it behind would create the `timestamptz`
  island Phase 8 refused to start, just with the polarity flipped.
- Its own reason is that `UsersService.isLocked` is
  `user.lockedUntil.getTime() > Date.now()` — a comparison of two *instants*, written
  that way because that is what the lock means. It is the one column in the schema
  read back and compared against the current time on every authenticated login, and
  the only one where a shifted read produces a security-relevant outcome rather than a
  cosmetic one: a fifteen-minute lock that expires immediately, or that outlives its
  window by most of a working day.

  **[Correction history — three rounds, now closed by experiment, §5]** This bullet
  has been wrong twice and is now settled by actually running the case, which is worth
  leaving on the record rather than tidying away.

  1. The plan originally claimed the everyday path was already broken here — every
     naive column, `locked_until` included, uniformly exposed.
  2. That was retracted on the grounds that `locked_until` has exactly one writer and
     one reader, both Node/TypeORM, so a single process writing and reading its own
     value is self-consistent under either column type. Retracted *again*, once the
     write-path model underneath it turned out wrong: if every TypeORM write is cast
     through Postgres's session zone (as the corrected §1 mechanism first stated it),
     writing and reading in "Node's zone" don't cancel, because the write never used
     Node's zone to begin with — so `locked_until` would be exposed exactly like every
     other naive column, and (2) would be wrong for the same reason (1) was retracted.
  3. **Tracing the actual SQL — not the general shape of "TypeORM's write" — settled
     it.** `@CreateDateColumn`/`@UpdateDateColumn` defer to `DEFAULT`/
     `CURRENT_TIMESTAMP` (§1); `locked_until`'s explicit `new Date(...)` assignment does
     not have a database default to defer to, so it is sent as an actual parameter and
     keeps Node's own digits, offset discarded, exactly as (2) originally described.
     **Confirmed by experiment**: reverting `users.locked_until` to `type: 'timestamp'`
     and re-running the third test in `timestamps.integration.spec.ts`, under the same
     pinned-Postgres-session-zone harness that reliably fails the `created_at` tests on
     a revert, left it passing — the round trip stays correct because both the write and
     the read happen in Node's zone, and the pinned zone never enters either side of it.

  So (2)'s conclusion was right, reached the first time for close to the right reason
  and defended the second time on a model that briefly contradicted it before the model
  itself was corrected. **`locked_until` is not exposed to the everyday write-zone/
  read-zone split every `created_at`/`updated_at` column has; its exposure is narrower**
  — a restart onto a host with a different real zone, or a DST transition, between the
  write and a later read. `user.entity.ts`'s comment, this bullet, `business-rules.md`'s
  BR-080 note, and the third test's own comment all now say this rather than leaving it
  open.

  **This does not change the decision.** `locked_until` converts either way — on the
  inherited reason above if nothing else, rather than becoming a second `timestamp`
  island now that every other server-set column in the schema is `timestamptz` — but the
  *narrower* reason is the honest one, not the sweeping one this bullet reached for
  twice before checking.

### What the existing values mean — a pinned literal, not an ambient setting

`ALTER TABLE … ALTER COLUMN … TYPE timestamptz` with no `USING` clause interprets every
existing naive value in **the session's `TimeZone` setting** — an ambient value that depends
on who ran the migration, from where, with which environment. That is precisely the class of
implicit, machine-dependent behavior this phase exists to delete, so the migration will not
rely on it.

The honest reading of the existing data is "the wall-clock of the machine that wrote it,"
and §1's first decision established that there is exactly one such machine in this project.
So the migration pins that zone as an explicit literal, declared once at the top of the file:

```ts
// The zone the existing naive values were written in — see the header comment.
const SOURCE_ZONE = 'Asia/Ho_Chi_Minh';
```

and every clause reads `USING "created_at" AT TIME ZONE '${SOURCE_ZONE}'`.

**One literal is not enough, though, once the write-zone/read-zone mechanism above is
precise about which zone wrote which column.** The ten audit columns' existing digits
were written in **Postgres's session zone** (they defer to `DEFAULT`/`CURRENT_TIMESTAMP`
— §1); `locked_until`'s were written in **Node's zone** (it's an application-computed
parameter — §1's `locked_until` bullet). `SOURCE_ZONE` names the first; a second
constant, `SOURCE_ZONE_NODE`, names the second, used only in `locked_until`'s two
clauses. On this project they're equal, for the same reason `SOURCE_ZONE` is a single
value at all — Node and Postgres run on one developer's machine (`tools/README.md`) —
but they are not a second name for the same fact, and the migration's header comment
says so explicitly: a deployment where the two processes' real zones differed would
need to set each constant from its own evidence, not assume one literal covers both.

**Fork A below records the alternative** (`current_setting('TimeZone')`, which is what the
bare form does implicitly) and why the literal wins: a migration is a reviewed artifact, and
a reviewer reading `AT TIME ZONE 'Asia/Ho_Chi_Minh'` is *prompted* to ask whether that is
true of the database in front of them. A reviewer reading no `USING` clause at all is
prompted to ask nothing, and gets whatever the session happened to be set to. The literal
can be wrong; the ambient form can be wrong *silently*, which is the difference that matters
in a conversion that cannot be inspected afterward.

`down()` uses the same literal in the other direction —
`USING "created_at" AT TIME ZONE '${SOURCE_ZONE}'` on a `timestamptz` column produces the
naive local reading — so a revert restores the original bytes exactly. **This is the first
migration in the project that converts rather than adds**, which makes it the first whose
`down()` can lose information if it is wrong. §6 gives the round-trip its own verification
step rather than trusting the symmetry by inspection.

### One `ALTER TABLE` per table, not one per column

Each `ALTER COLUMN … TYPE` on a table rewrites that table and takes an `ACCESS EXCLUSIVE`
lock. Postgres will batch multiple `ALTER COLUMN` clauses in a single `ALTER TABLE`
statement into **one** rewrite, so the migration issues six statements, not eleven:

```sql
ALTER TABLE "products"
  ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'Asia/Ho_Chi_Minh',
  ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'Asia/Ho_Chi_Minh';
```

At this project's scale (dozens of products, tens of transactions a day, an audit log that
is empty on a fresh seed) all six rewrites together are milliseconds and the lock is
irrelevant. Saying that is not the same as saying it does not matter: the thing that would
change the answer is `audit_events` growing to the size Phase 9 §7 named as the trigger for
a retention policy, at which point this migration becomes a table rewrite under an exclusive
lock on the largest table in the schema. **That is a second, independent reason to do this
now rather than later**, and it belongs in this section rather than in a footnote.

Two details that will otherwise be discovered at the wrong moment:

- **`IDX_audit_events_created_at` is rebuilt automatically** by the rewrite. Nothing to
  write, but a reviewer who does not know that will look for the `REINDEX` that is not
  there.
- **The `DEFAULT now()` expressions survive the type change.** Postgres re-coerces the
  stored default when the column type changes, and `now()` is natively `timestamptz`, so it
  needs no cast — it gets *more* correct, not less. The migration should verify this rather
  than assume it (§6 step 1 checks `information_schema.columns` for both `data_type` and
  `column_default`), because the failure mode of a silently-dropped default is a `NOT NULL`
  violation on the next insert, and that would surface as a broken seed rather than as a
  broken migration.

### Six entity files, and why the app does not break between the two steps

Every affected column is declared in exactly one entity file, and the change is one option
each:

- `Product`, `Supplier`, `Category`, `User` — `@CreateDateColumn({ name: 'created_at' })`
  and `@UpdateDateColumn({ name: 'updated_at' })` gain `type: 'timestamptz'`.
- `InventoryTransaction` — `@CreateDateColumn` only (BR-051; there is nothing for an
  `updated_at` to record). `occurredAt` is already `type: 'timestamptz'` and is not touched
  — after this phase it stops being the exception and starts being the example.
- `AuditEvent` — `@CreateDateColumn` only, same rule, second instance.
- `User.lockedUntil` — the one plain `@Column`, `type: 'timestamp'` → `'timestamptz'`.

**The migration and the entity change do not have to land together, and §6 deliberately
lands them separately.** With `synchronize: false` (`database.module.ts`) TypeORM never
compares its metadata against the live schema, and the `pg` driver picks its result parser
from the *column's* OID rather than from the entity's declared type — so between step 1 and
step 2 the app reads a `timestamptz` column into a field declared `timestamp` and gets the
correct `Date` anyway. That property is what makes step 1 individually shippable, the same
"nothing before step N has to be reverted if step N goes wrong" arrangement Phases 5 through
9 all made.

### The one thing this makes newly invisible

`inventory_transactions` is the only table with both kinds of time on it, and
`domain-model.md` §8 explains the distinction at length: `occurred_at` is a **business
fact** (when the stock movement happened in the world, user-supplied, backdatable,
BR-052-constrained), `created_at` is an **audit fact** (when the row was written, server-set,
never backdated).

Today that distinction is legible from the schema alone — one column is `timestamptz` and
the other is not. **After this phase both are `timestamptz`, and the difference is carried
entirely by the column names and by §8's prose.** That is a real, small loss and the plan
names it rather than letting a future reader discover that the doc is now the only place the
difference lives. It is not an argument against the change: the type was never *encoding*
the business/audit distinction, it was encoding "someone thought harder about this one
column," and two columns being different types for reasons unrelated to what they mean is
how the schema got into this state. §4 puts one sentence in §8 saying exactly this.

### No new configuration, no `.env.example` change, no new business rule

Three inverses worth recording together, because each has a phase it is the inverse of:

- **No configuration** — the inverse of Phase 8's "configuration, not constants," and the
  same call Phase 9 made. `SOURCE_ZONE` and `SOURCE_ZONE_NODE` are literals in one
  migration file, not env vars: a deployment does not tune them, and there is no test
  that needs to vary them. Env vars here would also be actively worse than constants,
  because they would let a migration produce different data on two machines with no
  record of which one it ran on.
- **No new BR.** A column type is not a rule about the business. Nothing in
  `business-rules.md` changes meaning: BR-051's immutability, BR-052's future-date check,
  BR-080's fifteen-minute lock, and BR-082's append-only record all say exactly what they
  said before. `business-rules.md` gets one cross-reference and no new rule, and §4 records
  the absence with its reason the way Phases 7 and 8 recorded "no new FR."
- **No new FR** — the third instance, after Phases 7 and 8. "What type a server timestamp is
  stored as" is not a user goal in `product.md` §4, and no Owner opens a screen to do
  anything with it. The contrast with Phase 9 (which *did* add FR-065, and said why) is the
  point of keeping all four notes in the same section.

### Two flagged scope forks

Every plan in this series has one or two, decided explicitly rather than drifted into.

**Fork A — the assumed source zone: a pinned literal, or `current_setting('TimeZone')`.
Recommended: the pinned literal** (§1 above).

The case for `current_setting('TimeZone')` is real and should be stated at its strongest: it
is correct *by construction* on any machine where the rows were written by that same server
under its normal configuration, which is every machine this migration will ever actually run
on. The literal, by contrast, is a hard-coded fact about one developer's box that a second
deployment would have to notice and change.

It loses anyway, on this phase's own logic. The failure mode of the literal is loud — a
reviewer reads a zone name and either agrees or does not. The failure mode of
`current_setting` is silent, and it is the *same* failure mode the phase exists to remove:
a value whose meaning depends on ambient machine state that nothing records. Choosing the
implicit form to migrate away from implicitness would be a joke at the phase's expense. The
literal ships, and the migration's header comment states the assumption in one sentence so
the next deployment is prompted rather than surprised.

**Fork B — re-seed the dev database after migrating, or migrate the existing rows and
verify. Recommended: migrate and verify; do not re-seed.**

`smart_inventory` is the only database in this project holding rows anyone would miss, and
even those are demo data that `npm run seed` regenerates in seconds. The tempting move is
therefore to migrate the schema, drop the data, re-seed, and never have to think about what
the old values meant.

That is refused, and the reason is not sentimentality about demo rows: **re-seeding would
throw away the only real evidence that the conversion did what this plan says it does.**
Every argument in §1 is a claim about how existing naive values are reinterpreted, and the
one place in this project where that claim can be checked against actual data is the dev
database's existing rows. §6 step 1 records a handful of timestamps before the migration and
compares them after; re-seeding first would make that check vacuous and leave the `USING`
clause untested until the first time it runs somewhere it matters.

The two test databases are the opposite case and need no decision at all: `smart_inventory_e2e`
is truncated by every spec's `beforeEach`, and `smart_inventory_test` is `dropSchema: true`.
Neither holds anything, which is why §6 treats them as schema problems rather than data ones.

---

## 2. What's new (backend)

### No new dependency, no new module, no new file outside `migrations/`

Worth noting because it is unusual even for this series: Phase 8 added a dependency, Phase 9
added a module, and this phase adds **one migration file and eleven decorator options**. If
the diff is larger than that, something has been misunderstood.

### Migration `1787740000000-ConvertTimestampsToTimestamptz.ts`

Sorting after `1787650000000-AddAuditEvents`. Six `ALTER TABLE` statements up, six down.

```ts
// Phase 10 (docs/phase-10-plan.md): the schema-wide timestamptz conversion Phase 7 §7
// parked, Phase 8 §1 declined to reopen, and Phase 9 §1 deferred a third time while
// writing down the exact column list. This migration is that list.
//
// WHAT THE EXISTING VALUES MEAN. A `timestamp without time zone` stores a clock
// reading and does not record which clock. The ten audit columns defer to
// `DEFAULT`/`CURRENT_TIMESTAMP` (`@CreateDateColumn`/`@UpdateDateColumn` never send a
// computed value when the entity carries none of its own — the only way this app uses
// them), so their digits are POSTGRES's, written in its session zone. `locked_until` is
// an application-computed parameter with no database default to defer to, so its
// digits are NODE's own. Every reader (`pg`'s postgres-date) reinterprets whichever
// digits it gets as local time in NODE's zone regardless. Two different write zones,
// one read zone, agreeing only because both processes run on one developer's machine
// (tools/README.md) — the assumption this whole migration rests on: if you are running
// this against a database where that agreement didn't hold, SOURCE_ZONE and
// SOURCE_ZONE_NODE below need independent values, not one literal for both.
//
// Not a no-op and not silently reversible-by-default: this is the first migration in
// the project that CONVERTS rather than ADDS, so down() must restore the original
// naive readings exactly — it uses the same two constants in the opposite direction.
//
// occurred_at is deliberately absent: it has been timestamptz since InitSchema.
const SOURCE_ZONE = 'Asia/Ho_Chi_Minh';
// locked_until's digits are Node's, not Postgres's session's (see above). Equal to
// SOURCE_ZONE here for the same reason SOURCE_ZONE is a single value at all — kept a
// separate constant so collapsing the two back together isn't the easy mistake to make
// on a deployment where they aren't equal.
const SOURCE_ZONE_NODE = 'Asia/Ho_Chi_Minh';
```

```
up:   (one statement per table, so each table is rewritten once, not twice)
  ALTER TABLE "products"               ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE $ZONE,
                                       ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE $ZONE
  ALTER TABLE "suppliers"              ALTER COLUMN "created_at" … , ALTER COLUMN "updated_at" …
  ALTER TABLE "users"                  ALTER COLUMN "created_at" … , ALTER COLUMN "updated_at" … ,
                                       ALTER COLUMN "locked_until" TYPE timestamptz USING "locked_until" AT TIME ZONE $ZONE_NODE
  ALTER TABLE "categories"             ALTER COLUMN "created_at" … , ALTER COLUMN "updated_at" …
  ALTER TABLE "inventory_transactions" ALTER COLUMN "created_at" …          -- occurred_at untouched
  ALTER TABLE "audit_events"           ALTER COLUMN "created_at" …          -- index rebuilt by the rewrite

down: the same six statements with `TYPE timestamp USING "col" AT TIME ZONE $ZONE`
      ($ZONE_NODE for locked_until)
```

`locked_until` is nullable; `AT TIME ZONE` on `NULL` is `NULL`, so no special case is
needed — worth a one-line comment because the absence of a `CASE` is the kind of thing a
reviewer stops on. It also uses `$ZONE_NODE`, not `$ZONE` — a second thing a reviewer
who only skims the other ten clauses could miss.

### Six entity files, one option each

| File | Change |
|---|---|
| `products/product.entity.ts` | `@CreateDateColumn`/`@UpdateDateColumn` → `{ …, type: 'timestamptz' }` |
| `suppliers/supplier.entity.ts` | same |
| `categories/category.entity.ts` | same |
| `users/user.entity.ts` | same, **plus** `lockedUntil`'s `type: 'timestamp'` → `'timestamptz'` |
| `inventory/inventory-transaction.entity.ts` | `@CreateDateColumn` only; `occurredAt` untouched |
| `audit/audit-event.entity.ts` | `@CreateDateColumn` only |

Two comments earn their place in the diff and the rest do not:

- `inventory-transaction.entity.ts` — one line beside `occurredAt` noting that it is no
  longer the schema's exception, and that the business-fact/audit-fact distinction now lives
  in the names and in `domain-model.md` §8 rather than in the types (§1).
- `user.entity.ts` — one line beside `lockedUntil` noting that this is not an audit column
  (Phase 8 said so) and converts anyway, with `isLocked`'s instant comparison as the reason
  (§1).

### The three databases, and the one that gets forgotten

Phase 9 §2 had a "three entity registries, all three of which must be updated" section
because the third one hides. This phase has the same shape with databases:

- **`smart_inventory`** (dev/demo, `backend/.env`) — `npm run migration:run`. Holds the only
  rows anyone would miss, which is why fork B verifies rather than re-seeds.
- **`smart_inventory_e2e`** (the e2e suite's database, set at the top of every e2e spec) —
  built by migrations out of band; the specs `TRUNCATE` but never create. **This is the one
  that gets forgotten**, and the failure is confusing rather than loud: the suite runs
  against a stale `timestamp` schema and passes, so the phase looks green while having
  changed nothing the e2e tests touch.
- **`smart_inventory_test`** (integration, `test-data-source.ts`) — `synchronize: true` and
  `dropSchema: true`, so the entity change alone rebuilds it and there is nothing to run.
  Named explicitly so nobody hand-writes a step for it.

### `run-seed.ts` — no change

Fresh seed rows are written through repositories with the new metadata against the new
columns; there is nothing to backfill, nothing to reinterpret, and nothing about the seed
that knew the old type. Consistent with Phases 7, 8, and 9, each of which left the seed
alone for its own reason.

### `configuration.ts` and `.env.example` — no change

§1. The zone lives in one migration file as a constant, deliberately not as a knob.

---

## 3. Frontend changes

**None.** This is the first phase since Phase 7's backend-only half where that is the whole
section, and it is worth two sentences rather than one word.

`frontend/index.html` reads every timestamp with `new Date(isoString)` and renders it
through `UI.fmtDate`/`UI.fmtDateTime` in the browser's own zone
(`Views.historyView`, `Views.auditLog`, `UI.auditMetaHtml`, and the three transaction
tables). Because §1 establishes that the ISO strings do not change, every one of those
renders identically before and after. There is nothing to update and — the part actually
worth checking — nothing that silently depended on the old behavior.

**Explicitly out of scope, and named because it is the adjacent-looking thing:** a
per-user or per-business timezone preference, a "display in the business's zone" setting, or
any timezone indicator in the UI. Phase 7 §7 already put "timezones-in-UI" out of scope by
name, and it stays there. A display preference is a product decision about who is reading
the screen; this phase is a storage decision about what the number means. They are related
only by the word "timezone."

---

## 4. Documentation updates

1. **`domain-model.md` §8** — the convention gains its type. §8 currently says every
   server-set timestamp is `created_at`, and mutable rows also get `updated_at`; it now also
   says **every server-set timestamp column is `timestamptz`**, with `occurred_at` no longer
   an exception but the earliest example. The "`occurred_at` vs. `created_at`" subsection
   gains one sentence recording §1's named loss: the two are now the same type, so the
   business-fact/audit-fact distinction is carried by the names and by that subsection
   alone.

2. **`architecture-observations.md`** — the "known, deliberately deferred question" parked
   since Phase 7, declined by Phase 8, and counted column-by-column by Phase 9 is
   **resolved**. Rewrite it as a resolved entry: the date, the eleven columns (kept as the
   record of what was converted, not deleted), the pinned `SOURCE_ZONE`/`SOURCE_ZONE_NODE`
   and why they're two constants (§1 fork A), and the write-zone/read-zone finding that
   was the actual argument — plus the record of how many rounds it took to state that
   finding correctly (§5). Worth noting in the entry itself that this is the first item
   that file has ever *closed* rather than accumulated — its stated purpose is to inform
   later decisions with evidence, and an entry that only ever grows is not evidence of
   anything.

3. **`requirements.md`** — a third "no new FR" note beside the Phase 7 and Phase 8 ones,
   with its own reason (§1): a column type is not a user goal. Keeping all three, and the
   contrast with Phase 9's FR-065, is what makes the section legible as a record of
   judgement rather than a list.

4. **`business-rules.md`** — **no new BR**, recorded as such in one line. BR-051, BR-052,
   BR-080, and BR-082 all say exactly what they said before. BR-080 gains a cross-reference
   only: the fifteen-minute lock is now immune to a restart onto a differently-zoned host
   or a DST transition between the lock and the check — its narrower, settled exposure
   (§1's `locked_until` bullet), not the audit columns' everyday one.

5. **`product.md` §11** — a Phase 10 cross-reference in the style of the Phase 7 entry,
   which is the right precedent because this is the same kind of change: a data-model
   consistency edit with no product-level edit at all. §4 gains no user goal and §5 gains no
   use case — the deliberate contrast with the Phase 9 entry directly above it. Q-4, Q-6,
   and Q-7 remain exactly as open as before.

6. **`api.md`** — title bumped to Phase 10, and one sentence in the opening paragraph: every
   timestamp field in every response is an ISO instant and always has been; as of this phase
   the schema guarantees it rather than a convention doing so. **No route's shape, status
   code, or field list changes** — and saying that explicitly is worth the line, exactly as
   Phase 9 said it about the audit side effects.

7. **`README.md`** — Current phase updated, plus one operational note in the spirit of the
   Riley, lockout, and empty-audit-log ones: **after pulling this, run `npm run
   migration:run` against `smart_inventory` *and* against `smart_inventory_e2e`** (§2). The
   e2e database is the one that otherwise fails in a way that looks like a broken test rather
   than an unmigrated schema.

8. **`docs/learning-notes/database-access.md`** — extended, **not** a new note: the
   deliberate inverse of Phase 9, which added `cross-cutting-concerns.md` and flagged the
   addition as a judgement call. This subject belongs squarely in the note that already
   covers TypeORM and `pg` mechanics. Content: `timestamp` vs `timestamptz` as "a clock
   reading" vs "an instant"; what the `pg` driver does with each on read and on write; why
   "the column has no zone, so it must be UTC by convention" is a convention nothing
   enforces; and `ALTER COLUMN … TYPE … USING … AT TIME ZONE` as the one place in a
   codebase's life where that assumption has to be written down and defended. The
   generalizable lesson, in the shape that file's other sections use: **a type that stores
   less than the value means has to be paid for by an agreement, and an agreement between two
   processes that neither one checks is not a design, it is a coincidence that has not failed
   yet.**

---

## 5. Testing plan

The honest shape of this phase's testing is unusual and has to be stated before the list:
**the existing suite cannot distinguish before from after.** Every test runs on one machine
where Node and Postgres share a zone, which is exactly the condition under which the old
schema is already correct. A green suite after this migration proves the migration did not
*break* anything; it proves nothing about what the migration was *for*.

So there is one new test, it is the phase's headline, and it works by forcing the condition
the rest of the suite cannot produce.

- **Integration — `timestamps.integration.spec.ts`** (new, real Postgres via
  `createTestDataSource()`, which is `synchronize: true` and therefore builds the new schema
  straight from the entity metadata):

  - **The round trip to the real instant — as actually built, after two corrections
    this plan's own description below got wrong.** The plan as originally written
    called for `process.env.TZ` set to a mismatched zone at the top of the file
    (matching `auth.e2e-spec.ts`'s `THROTTLE_LOGIN_LIMIT`/`AUTH_LOCKOUT_MINUTES`
    pattern), and for comparing a TypeORM-written row against a `DEFAULT now()`-written
    row. Neither survived contact with a real run:
    - **`process.env.TZ` doesn't reliably change what `Date` treats as local time in
      this Jest setup.** On this platform, Jest's own bootstrap already touches `Date`
      before a test file's top-level statements run, caching the process's real OS
      zone into V8 before the assignment can take effect — a
      `new Date().getTimezoneOffset()` check placed immediately after the assignment
      still reported the original zone. A first version of this test used exactly the
      broken pattern above, silently proved nothing (Node's zone never actually
      moved), and still turned green. The fix: pin **Postgres's session zone**
      instead, via `pg`'s `options: '-c timezone=<zone>'` connection parameter
      (applied once, at connection-open time, for every pooled connection — no
      caching problem to fight), passed through a small optional-`extra` parameter
      added to `createTestDataSource()`.
    - **Comparing the two writers against each other proves nothing, and the reason why
      was itself found in two steps.** First step: tracing the write path showed
      `@CreateDateColumn`/`@UpdateDateColumn` get cast through Postgres's *session* zone
      on the way into a naive `timestamp` column, same as `DEFAULT now()` — both writers
      depend on the same session zone, so they always agree with each other, even on a
      reverted schema. A test comparing them stayed green after the sanity-check revert
      it was supposed to catch. Second step, and the one that actually mattered: logging
      the generated SQL showed *why* — `INSERT INTO "categories"(...) VALUES ($1,
      DEFAULT, DEFAULT)`. TypeORM never sends a computed `Date` for these columns at all
      when the entity carries no value for them (the only way this app ever uses them);
      it emits the literal `DEFAULT`, and Postgres's own `DEFAULT now()` takes it from
      there. "TypeORM's write" isn't one mechanism — it's `DEFAULT`/`CURRENT_TIMESTAMP`
      deferral for these two decorators specifically, indistinguishable at the SQL level
      from a raw `DEFAULT now()`. The actual corruption is on the **read** side: a naive
      column's digits carry no zone marker, so reading them back reinterprets whatever
      was stored as local time in the *reading* process's own zone, which is wrong
      whenever it differs from the zone the digits were written in. The test that
      actually discriminates compares a round-tripped value against the real wall-clock
      instant the write happened at (`Date.now()` captured immediately before/after),
      for both the TypeORM row and the `DEFAULT now()` row independently — verified, by
      deliberately reverting `categories.created_at` to `timestamp` and re-running, to
      fail by exactly the pinned zone's offset from Node's real zone, then to pass again
      once reverted back.
    - A `beforeAll` guard compares Postgres's session offset against Node's real
      offset and throws if they coincide — the check that would have caught the first
      version's silent no-op immediately instead of leaving it to be found later.
  - **`locked_until` survives a round trip as an instant — and, now settled by
    experiment, is not also a regression guard the way the test above is (§1).** Write a
    lock fifteen minutes out through `UsersService.registerFailedLogin`'s path, read it
    back, and assert `isLocked` is true and the remaining window is fifteen minutes ± a
    tolerance. It pins the *functional* claim that motivates converting a column Phase 8
    explicitly called non-audit, so a future reader who finds that inclusion odd finds
    the test that explains why.

    **Whether it would also fail on a reverted schema went through three answers before
    landing on the right one.** "No" (one writer, one reader, both Node, self-consistent)
    — reached under a `process.env.TZ` harness that, per the bullet above, never actually
    took effect, so it couldn't have observed a shift either way. Then "yes" (this column
    is exposed exactly like `categories.created_at`) — reached once the write-path model
    said every TypeORM write goes through Postgres's session zone, which would mean
    writing and reading in "Node's zone" don't cancel after all. Then back to **no**,
    once logging the generated SQL for `persistLoginState`'s `UPDATE` showed
    `locked_until` sent as an actual bound parameter (`"locked_until" = $2`, not
    `DEFAULT`/`CURRENT_TIMESTAMP`) — because it is an application-computed value with no
    database default to defer to, unlike the audit columns. That parameter is formatted
    by `pg` using **Node's own zone**, offset discarded by the naive column, same as the
    original reasoning described — the write and the read really do both happen in
    Node's zone, so they cancel, and reverting `users.locked_until` to `type: 'timestamp'`
    and re-running this test under the pinned-zone harness confirmed it: still green,
    where the two tests above fail reliably under the same revert.

    So this column's actual exposure is narrower than the audit columns': not "Postgres's
    session zone and Node's zone disagree, continuously," but "Node's own zone changes
    between the write and a later read" — a restart onto a differently-configured host,
    or a DST transition. §1's `locked_until` bullet, `business-rules.md`'s BR-080 note,
    `user.entity.ts`, and this test's own comment all say this now.

- **Migration round-trip — verified, not unit-tested.** `up()` then `down()` then `up()`
  against a copy of the dev database, asserting a recorded set of timestamps returns to its
  original bytes. This is the first converting migration in the project (§1) and its `down()`
  is the first that can lose information, but a Jest test that runs migrations against a
  scratch database is a test harness this project does not have and does not otherwise need.
  §6 makes it an explicit manual step with a recorded result instead — the same call
  Phases 6–9 made about migration behavior generally.

- **Existing suites — must pass untouched, and this phase's regression risk is the lowest
  since Phase 7.** No signature changes anywhere (contrast Phase 9's dozen), no new columns
  for a raw `INSERT` to trip over (contrast Phases 6, 7, and 8), no new guard, DTO, or route.
  The five e2e specs' raw `INSERT INTO users (name, role, email, password_hash) …` name no
  timestamp column and are unaffected; `audit.e2e-spec.ts`'s `days` filter and
  `auth.e2e-spec.ts`'s lockout auto-expiry (which runs on a three-second window,
  `AUTH_LOCKOUT_MINUTES=0.05`) both exercise the converted columns and both should be
  entirely unmoved.

  **The real risk is not in the code, and pretending otherwise would be the mistake.** It is
  in the two places §2 already named: the `USING` clause's assumption, and
  `smart_inventory_e2e` not having been migrated. Both are operational, both are checked in
  §6, and neither is something a test in this repository can catch.

- **No new unit test.** There is no branch, no service method, and no computed value to
  pin — the whole change is declarative. A unit test asserting that a decorator carries
  `type: 'timestamptz'` would be a test of TypeORM's metadata reader, not of this project.

---

## 6. Rollout order

1. **The migration alone, entities untouched, against `smart_inventory`.** First: record
   the current values — `SELECT id, created_at, updated_at FROM users ORDER BY id` and the
   same for a handful of `inventory_transactions` and `audit_events` rows — because fork B's
   verification depends on having them. Run `npm run migration:run`. Then check three things
   in `psql`: every one of the eleven columns reads `timestamp with time zone` in
   `information_schema.columns`, every `DEFAULT now()` is still present in `column_default`
   (§1), and the recorded values display unchanged. **The app keeps working through this
   step** — `synchronize: false` means TypeORM never compares metadata to schema, and the
   `pg` driver picks its parser from the column's OID (§1) — so this step is individually
   shippable and independently verifiable, the same de-risking arrangement Phases 8 and 9
   put first.
2. **Verify `down()`, then re-apply.** `npm run migration:revert`, confirm the recorded
   values are byte-identical to step 1's `SELECT`, `npm run migration:run` again. Done here,
   deliberately, rather than trusting the symmetry of the `USING` clauses by reading them —
   this is the project's first converting migration and the only cheap moment to find out
   that its reverse is wrong is before anything depends on it.
3. **The six entity files.** Metadata now matches schema. Run the full unit and integration
   suites — `smart_inventory_test` is `dropSchema: true`/`synchronize: true`, so it rebuilds
   itself from the new metadata with no migration and no manual step (§2).
4. **`npm run migration:run` against `smart_inventory_e2e`, then the full e2e suite.** Its
   own step because it is the one that gets forgotten (§2) and the one whose omission looks
   like success.
5. **The new integration spec** (§5) — the zone-mismatch round trip and the `locked_until`
   window. Last among the code steps on purpose: it is the only test that can fail *for the
   right reason*, and running it against a tree where steps 1–4 are already green means a
   red result points at the phase's actual subject rather than at its plumbing.
6. **Documentation** (§4) — `domain-model.md` §8, the resolved
   `architecture-observations.md` entry, the third no-FR note, the no-BR line, `product.md`
   §11, `api.md`, `README.md`, and the extended `database-access.md`. As in every phase in
   this series, these are the deliverables that outlast the code and are not optional in any
   cut.

Steps 1 through 5 are no-ops from every client's point of view — no route's response
changes at any point in the sequence (§1). If this phase is cut short, the coherent stopping
point is **after step 4**: schema and entities agree, everything works, and what is missing
is the test that proves why it was worth doing. Stopping after step 1 or 2 is also safe but
pointless — it leaves the schema converted and the reason for it undocumented, which is the
state Phases 7 through 9 were each trying not to create.

---

## 7. Explicitly out of scope for Phase 10 (Future)

- **`inventory_transactions.occurred_at`** — already `timestamptz` since `InitSchema`.
  Listed first because it is the column a reviewer will check for, and its absence from the
  migration is the correct answer rather than an oversight.
- **A per-user or per-business timezone preference, or any timezone display in the UI** —
  §3. Phase 7 §7 put "timezones-in-UI" out of scope by name and it stays there; a display
  preference is a product decision about the reader, not a storage decision about the value.
- **Changing how BR-052's "not in the future" check computes today** —
  `InventoryService.assertNotFuture` takes Node's local end-of-day and compares it against
  an already-`timestamptz` `occurred_at`. This phase does not touch it, and it should not:
  whether "today" for a backdated delivery means the server's day, the business's day, or
  the browser's day is a business-rule question with a real answer, not a side effect of a
  column type. If it is ever asked, it is asked about BR-052.
- **Pinning the connection's session timezone** (`TZ=UTC` in `.env.example`, or
  `extra: { options: '-c timezone=UTC' }` on the DataSource) — the intuitive-looking
  belt-and-braces addition, and after this phase it is a **no-op that would look like a
  safety measure**. Once the columns are `timestamptz`, the session zone affects how a value
  is *displayed* in `psql` and nothing about the instant that is stored or the `Date` the
  driver returns. Adding it would suggest the type change was insufficient, which is exactly
  the wrong thing for the next reader to believe.
- **A `CHECK` constraint or trigger enforcing anything about these columns** — there is no
  invariant to enforce that the type does not already guarantee, and Phase 9 §2's reasoning
  for declining `@Check` on `audit_events` applies verbatim.
- **`last_login`** — still not a column, still a genuinely different thing with its own
  write path (stamped on authentication, not on edit), exactly as Phase 7 §7 recorded. Note
  that Phase 9 made it *less* needed rather than more: `audit_events` already records every
  `login_succeeded` with its subject and time.
- **A retention or pruning policy for `audit_events`** (Phase 9 §7) — still parked, still
  with its concrete trigger unfired, still not this phase's problem. Named here only because
  §1 uses the same table's growth as an argument for doing *this* now.
- **A shared throttle store** (Phase 8 §7) — still parked, still recorded in
  `architecture-observations.md`.
- **Export, tamper-evidence, alerting, or a dashboard tile derived from the audit log**
  (Phase 9 §7) — all unchanged, none of them adjacent to this.
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.
  Q-7 is worth one clause: a business timezone is the kind of column that arrives *with*
  multi-location, and this phase deliberately does not anticipate it (A-1).
- **Q-6, adjustment approval workflow** — still open, still untouched, still not resolved by
  anything here, exactly as Phases 5, 6, 7, 8, and 9 each recorded.

---

## 8. Definition of done

- [x] All eleven plain `TIMESTAMP` columns across the six tables (§1's table) are
      `timestamp with time zone`, converted in **one** migration with **one** `ALTER TABLE`
      per table, verified against `information_schema.columns` rather than by reading the
      migration.
- [x] Every `DEFAULT now()` survived the conversion and is still present in
      `column_default` — checked, not assumed, because a dropped default surfaces as a
      broken seed rather than as a broken migration.
- [x] `inventory_transactions.occurred_at` was **not** touched, and the entity comment says
      why it is now the earliest example of the convention rather than its exception.
- [x] The migration names its assumed source zone as an explicit literal with a header
      comment stating the assumption (§1 fork A), and `down()` restores the original naive
      readings exactly — proven by a revert-and-recompare against recorded values, not by
      inspection.
- [x] `users.locked_until` converted along with the audit columns, with a comment recording
      that it is not an audit column (Phase 8 said so), why it converts anyway, and —
      settled by experiment, §1/§5 — why its actual exposure (a restart onto a
      differently-zoned host, or a DST transition) is narrower than the audit columns'
      everyday write-zone/read-zone split.
- [x] All six entity files declare `type: 'timestamptz'` on every server-set timestamp, and
      no other line of application code changed — no service, controller, DTO, guard, route,
      or frontend file is in the diff. (`database/test-data-source.ts` also changed — test
      infrastructure, to let `timestamps.integration.spec.ts` pin a connection's session
      zone; still no application code.)
- [x] **No route's response changed.** A timestamp captured from a `GET /products`,
      `GET /users`, `GET /inventory-transactions`, and `GET /audit-events` response before
      the migration is byte-identical after it — asserted, not assumed: verified by running
      the real app against `smart_inventory`, capturing all four responses, reverting the
      migration only (entities untouched), restarting, capturing again, and diffing — the
      only difference was the one new audit row the second login itself created.
- [x] A new integration test writes one row through TypeORM and one through `DEFAULT now()`
      and asserts each round-trips to the real wall-clock instant it was written at — **not**
      by comparing the two writers against each other (they turned out to always agree, even
      on a reverted schema — see §5) and **not** via `process.env.TZ` (doesn't reliably
      change what `Date` treats as local time under this project's Jest setup — see §5).
      Instead, Postgres's session zone is pinned via a dedicated connection option to a zone
      deliberately different from Node's real zone, with a `beforeAll` guard that fails loudly
      if the two ever coincide. Verified, by deliberately reverting
      `categories.created_at` to `timestamp` and back, to actually fail on the reverted
      schema and pass on the current one — the one test in the project that does.
- [x] A locked account's fifteen-minute window is fifteen minutes, asserted against the same
      pinned-zone test setup — pinning §1's *functional* argument for converting a column
      Phase 8 called non-audit. Whether this test *also* detects a reversion was checked by
      running it: reverting `users.locked_until` to `type: 'timestamp'` under the pinned-zone
      harness left it passing, unlike the two tests above, which fail reliably under the
      same revert — confirming this column's write path is Node-zone-governed, not
      Postgres-session-zone-governed like the audit columns, so this test pins the
      *functional* claim but is not itself a regression guard (§1, §5).
- [x] The migration has been run against **both** `smart_inventory` and
      `smart_inventory_e2e`; `smart_inventory_test` needed nothing, and the README says all
      three things.
- [x] `domain-model.md` §8 states the convention *as a type* and records that
      `occurred_at` vs `created_at` is now carried by name and prose alone;
      `architecture-observations.md`'s three-phase-old parked question is **resolved** with
      its column list kept and the corrected write-zone/read-zone mechanism recorded;
      `requirements.md` carries a
      third no-FR note; `business-rules.md` gains a cross-reference and **no new rule**;
      `product.md` §11 records a data-model change with no product-level edit;
      `api.md` (Phase 10), `README.md`, and `database-access.md` all reflect the phase — and
      Q-4, Q-6, and Q-7 are still recorded as open.
- [x] The two scope forks were decided and recorded either way: the pinned literal vs.
      `current_setting('TimeZone')` (§1 fork A), and migrate-and-verify vs. re-seed
      (§1 fork B).
- [x] Full backend suite green: unit, integration (including the new spec), and all six e2e
      specs.
