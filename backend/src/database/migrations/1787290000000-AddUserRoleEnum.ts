import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 5 (docs/phase-5-plan.md §2): `users.role` has been free-text
// (`character varying`) since InitSchema, descriptive-only. Now that it drives
// authorization (RolesGuard), a typo in a seed or a manual INSERT ('owner ',
// 'OWNER', 'Manager') would silently produce a user who can do nothing Owner-only
// and gets no error telling them why — so it becomes a real Postgres enum, the same
// pattern InitSchema already used for products_status_enum/suppliers_status_enum/
// inventory_transactions_type_enum.
//
// Same add-nullable-first shape AddAuthToUsers1787194988413 used, adapted for an
// ALTER COLUMN TYPE instead of an ADD COLUMN: normalize the existing free-text
// values, quarantine anything unrecognized onto the *less* privileged role (so a bad
// row can never be silently promoted by a migration), then constrain the type. Safe
// against an already-seeded database, not just an empty one.
export class AddUserRoleEnum1787290000000 implements MigrationInterface {
  name = 'AddUserRoleEnum1787290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('owner', 'staff')`,
    );
    // Normalizes the existing 'Owner'/'Staff' rows from the Phase 2 seed.
    await queryRunner.query(`UPDATE "users" SET "role" = lower("role")`);
    // Anything that still isn't a recognized role lands on the less-privileged one.
    await queryRunner.query(
      `UPDATE "users" SET "role" = 'staff' WHERE "role" NOT IN ('owner', 'staff')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE "public"."users_role_enum" USING "role"::"public"."users_role_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE character varying`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
  }
}
