import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 6 (docs/phase-6-plan.md §1 "Users are deactivated, never deleted" / §2):
// users.status reuses the shared EntityStatus lifecycle Product.status and
// Supplier.status already have, as its own per-table Postgres enum
// (users_status_enum) — the same pattern InitSchema established for those two tables
// and AddUserRoleEnum1787290000000 followed for users.role.
//
// Add-then-constrain, the same shape AddAuthToUsers1787194988413 and
// AddUserRoleEnum1787290000000 used: the column starts nullable, every existing row
// is explicitly backfilled to 'active', and only THEN does NOT NULL land — so this is
// safe to run against a database that already has seeded users, not just an empty
// one. A migration must never be able to lock anyone out.
//
// The DEFAULT 'active' is not decoration: app.e2e-spec.ts, auth.e2e-spec.ts,
// categories.e2e-spec.ts, and roles.e2e-spec.ts all seed users with a raw
// `INSERT INTO users (name, role, email, password_hash) ...` that doesn't mention
// status at all — without the default, all four break at once on a NOT NULL
// violation.
export class AddUserStatus1787380000000 implements MigrationInterface {
  name = 'AddUserStatus1787380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('active', 'inactive')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "status" "public"."users_status_enum"`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "status" = 'active' WHERE "status" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'active'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "status"`);
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
  }
}
