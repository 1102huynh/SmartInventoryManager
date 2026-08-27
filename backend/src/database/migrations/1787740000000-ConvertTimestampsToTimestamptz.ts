import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 10 (docs/phase-10-plan.md): the schema-wide timestamptz conversion Phase 7 §7
// parked, Phase 8 §1 declined to reopen, and Phase 9 §1 deferred a third time while
// writing down the exact column list. This migration is that list.
//
// WHAT THE EXISTING VALUES MEAN. A `timestamp without time zone` stores a clock
// reading and does not record which clock. Every created_at/updated_at column here is
// filled in by TypeORM's @CreateDateColumn/@UpdateDateColumn, which — whenever the
// entity carries no value of its own, the only way this app ever uses them — emit the
// literal DEFAULT (insert) / CURRENT_TIMESTAMP (update) rather than a computed value,
// so they ARE `DEFAULT now()` under the hood: evaluated by POSTGRES, in the SESSION's
// zone. Every reader (`pg`'s postgres-date) reinterprets the resulting digits as local
// time in NODE's zone instead. These never disagree with each other — every one of
// them defers to the same session zone — the write zone and the read zone do, and they
// only ever agreed because both processes run on one developer's machine
// (tools/README.md). SOURCE_ZONE below is that machine's zone — the zone the existing
// digits were written in — and it is the assumption this whole migration rests on: if
// you are running this against a database whose rows were written under a different
// Postgres session zone, change it FIRST and know why.
//
// users.locked_until is the one column here that does NOT follow this mechanism: it is
// an application-computed value (UsersService.registerFailedLogin) with no database
// default to defer to, sent to `pg` as an actual parameter and kept in NODE's zone, not
// the session's. It converts for a different, narrower reason — see that migration's
// entity comment (user.entity.ts) and docs/phase-10-plan.md §1.
//
// THAT DIFFERENCE MEANS ONE LITERAL IS NOT ENOUGH. SOURCE_ZONE below names the zone the
// existing digits were written in — but "the zone they were written in" is Postgres's
// session zone for the ten audit columns and NODE's zone for locked_until, and those are
// two different facts about two different processes, not one fact about "the machine."
// SOURCE_ZONE_NODE is therefore its own constant, not a second name for the same value:
// on this project it happens to equal SOURCE_ZONE only because Node and Postgres run on
// one developer's machine (tools/README.md), the same coincidence §1 built the whole
// migration around. Running this against a database where the two processes' zones
// genuinely differed would need to set SOURCE_ZONE to Postgres's session zone at write
// time and SOURCE_ZONE_NODE to Node's — independently, and knowing which is which.
//
// Not a no-op and not silently reversible-by-default: this is the first migration in
// the project that CONVERTS rather than ADDS, so down() must restore the original
// naive readings exactly — it uses the same two constants in the opposite direction.
//
// occurred_at is deliberately absent: it has been timestamptz since InitSchema.
const SOURCE_ZONE = 'Asia/Ho_Chi_Minh';
// The zone locked_until's digits were actually written in (Node's, not Postgres's
// session's — see above). Equals SOURCE_ZONE here for the same reason SOURCE_ZONE is a
// single value at all: one machine, both processes. Keep it a separate constant anyway
// — collapsing it back into SOURCE_ZONE is exactly the mistake this comment exists to
// prevent on a deployment where the two aren't equal.
const SOURCE_ZONE_NODE = 'Asia/Ho_Chi_Minh';

export class ConvertTimestampsToTimestamptz1787740000000
  implements MigrationInterface
{
  name = 'ConvertTimestampsToTimestamptz1787740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // One ALTER TABLE per table, not one per column — Postgres batches multiple
    // ALTER COLUMN clauses into a single table rewrite, so six tables means six
    // rewrites, not eleven.
    await queryRunner.query(`
      ALTER TABLE "products"
        ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "suppliers"
        ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}',
        -- locked_until is nullable; AT TIME ZONE on NULL is NULL, so no CASE is
        -- needed here even though this column (unlike its two neighbors above) isn't
        -- an audit column at all — see the entity comment on User.lockedUntil. It also
        -- uses SOURCE_ZONE_NODE, not SOURCE_ZONE: its digits were written in Node's
        -- zone, not Postgres's session zone — see the header comment.
        ALTER COLUMN "locked_until" TYPE timestamptz USING "locked_until" AT TIME ZONE '${SOURCE_ZONE_NODE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "categories"
        ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_transactions"
        ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    // occurred_at is untouched — it has been timestamptz since InitSchema.
    // IDX_audit_events_created_at is rebuilt automatically by this rewrite; nothing
    // to REINDEX by hand.
    await queryRunner.query(`
      ALTER TABLE "audit_events"
        ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same six statements, same two constants, reverse order and reverse direction:
    // `timestamptz ... AT TIME ZONE $ZONE` on the way down produces the naive local
    // reading that was there before up() ran, so a revert restores the original
    // bytes exactly rather than merely restoring the column type. locked_until still
    // uses SOURCE_ZONE_NODE, not SOURCE_ZONE — see the header comment.
    await queryRunner.query(`
      ALTER TABLE "audit_events"
        ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_transactions"
        ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "categories"
        ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}',
        -- SOURCE_ZONE_NODE, not SOURCE_ZONE — see the header comment.
        ALTER COLUMN "locked_until" TYPE timestamp USING "locked_until" AT TIME ZONE '${SOURCE_ZONE_NODE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "suppliers"
        ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
    await queryRunner.query(`
      ALTER TABLE "products"
        ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE '${SOURCE_ZONE}',
        ALTER COLUMN "updated_at" TYPE timestamp USING "updated_at" AT TIME ZONE '${SOURCE_ZONE}'
    `);
  }
}
