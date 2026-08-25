import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 9 (docs/phase-9-plan.md §2): a new table, not new columns — unlike Phases 6-8
// there is no backfill question at all and no existing raw INSERT in any e2e spec to
// keep compiling, since nothing referenced this table before it existed.
//
// entity_id carries no REFERENCES clause — deliberately, not an oversight. A
// product_deleted event points at an id that no longer exists, which is the entire
// point of recording it: a RESTRICT foreign key would forbid the delete BR-004
// permits, and CASCADE would erase the audit row the moment the thing it describes is
// deleted — the one thing an audit log must never do. actor_user_id and
// subject_user_id DO get real RESTRICT foreign keys, safe only because BR-076
// guarantees a users row can never disappear.
//
// Plain TIMESTAMP for created_at, matching every other server-set timestamp in this
// schema (domain-model.md §8) — the timestamptz question stays parked a third time
// (docs/phase-7-plan.md §7, docs/phase-8-plan.md §1).
export class AddAuditEvents1787650000000 implements MigrationInterface {
  name = 'AddAuditEvents1787650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "audit_events_event_type_enum" AS ENUM (
        'login_succeeded', 'login_failed', 'account_locked', 'password_changed',
        'user_created', 'user_updated', 'user_status_changed', 'user_password_reset',
        'product_created', 'product_updated', 'product_status_changed', 'product_deleted',
        'supplier_created', 'supplier_updated', 'supplier_status_changed',
        'category_created', 'category_updated', 'category_deleted'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "audit_events_entity_type_enum" AS ENUM ('user', 'product', 'supplier', 'category')
    `);
    await queryRunner.query(`
      CREATE TABLE "audit_events" (
        "id" SERIAL PRIMARY KEY,
        "event_type" "audit_events_event_type_enum" NOT NULL,
        "actor_user_id" INTEGER NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "subject_user_id" INTEGER NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "entity_type" "audit_events_entity_type_enum" NULL,
        "entity_id" INTEGER NULL,
        "summary" TEXT NOT NULL,
        "actor_ip" VARCHAR(45) NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_created_at" ON "audit_events" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_events_subject_user_id" ON "audit_events" ("subject_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_events"`); // takes its indexes with it
    await queryRunner.query(`DROP TYPE "audit_events_entity_type_enum"`);
    await queryRunner.query(`DROP TYPE "audit_events_event_type_enum"`);
  }
}
