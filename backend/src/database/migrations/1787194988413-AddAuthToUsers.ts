import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 3 (docs/phase-3-plan.md): adds the two columns real login needs. Columns are
// added nullable first and backfilled with placeholder values before the NOT NULL
// constraint lands, so this migration is safe to run against a database that already
// has seeded users from Phase 2 — not just an empty table. Those placeholders are
// immediately thrown away by `npm run seed`, which truncates the users table anyway
// (see README.md's local-dev instructions for the run-migration-then-reseed order).
export class AddAuthToUsers1787194988413 implements MigrationInterface {
  name = 'AddAuthToUsers1787194988413';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "email" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "password_hash" character varying`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "email" = 'user' || "id" || '@example.invalid', "password_hash" = '' WHERE "email" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email" ON "users" ("email")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_users_email"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email"`);
  }
}
