import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 21 (docs/phase-21-plan.md), issue #11. Gives @nestjs/throttler a shared,
// durable store so the configured limits still hold when the API runs as more than
// one instance — the successor Phase 8 §7 named. The throttle count now lives in
// Postgres, the same place account lockout already does; the "two storage models"
// split architecture-observations.md describes is closed by this table.
//
// Purely additive: one table, one index, nothing references it, no backfill. Safe
// against the seeded dev database and an empty one alike. run-seed.ts writes nothing
// here.
//
// No created_at / updated_at — domain-model.md §8's convention is about *audit*
// columns, and a disposable throttle counter the next request overwrites has no audit
// question to answer (the same call as the missing @UpdateDateColumn on the immutable
// tables, opposite reason). `expires_at` is server-set operational state, so
// timestamptz, per the users.locked_until precedent.
//
// UNLOGGED (docs/phase-21-plan.md §1 Fork B): no WAL for a per-request write whose
// data is ephemeral by nature — losing it in a crash just resets the limits for a few
// seconds. TypeORM cannot express UNLOGGED through decorators, so the integration test
// database (test-data-source.ts, synchronize: true) builds `throttle_hits` as an
// ordinary LOGGED table. That divergence is behaviourally invisible — durability and
// replication only, nothing a test asserts — and is the same shape of documented,
// expected difference as the @Check constraint names in Phase 18.
export class AddThrottleHitsTable1788010000000 implements MigrationInterface {
  name = 'AddThrottleHitsTable1788010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNLOGGED TABLE "throttle_hits" (
        "key" text NOT NULL,
        "hits" integer NOT NULL,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "PK_throttle_hits" PRIMARY KEY ("key")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_throttle_hits_expires_at" ON "throttle_hits" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_throttle_hits_expires_at"`,
    );
    await queryRunner.query(`DROP TABLE "throttle_hits"`);
  }
}
