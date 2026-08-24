import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 7 (docs/phase-7-plan.md): closes the two-table gap in the audit-timestamp
// convention. `products`, `suppliers`, and `inventory_transactions.created_at` have
// had their audit columns since InitSchema; `users` and `categories` never picked
// them up. Both tables' rows can change after creation (a user is edited — Phase 6;
// a category is renamed — Phase 4), so both get the full created_at/updated_at pair,
// not the create-only variant `inventory_transactions` deliberately keeps (see that
// entity's own comment — BR-051 makes those rows immutable, so there is nothing for
// an updated_at there to ever record).
//
// Unlike AddUserStatus1787380000000, this is a single step, not an
// add-then-backfill-then-constrain dance: `DEFAULT now()` at insert time already
// covers the NOT NULL requirement for a column that has no prior value to backfill
// from any business fact, so `ADD COLUMN ... TIMESTAMP NOT NULL DEFAULT now()` gives
// every pre-existing row the migration-run time and every future row the insert
// time, in one statement. The default is also what keeps every raw
// `INSERT INTO users (...)` / `INSERT INTO categories (...)` in the e2e specs
// (app.e2e-spec.ts, auth.e2e-spec.ts, categories.e2e-spec.ts, roles.e2e-spec.ts,
// users.e2e-spec.ts) compiling and passing untouched — none of them name these
// columns, so none of them break on a NOT NULL violation.
//
// Plain TIMESTAMP, not timestamptz — matching products.created_at,
// suppliers.created_at, and inventory_transactions.created_at, which are all plain
// TIMESTAMP. Only occurred_at (a business date, not an audit fact) is timestamptz.
// Migrating the existing audit columns to timestamptz is a real, separate,
// schema-wide question, deliberately not resolved here — see
// docs/architecture-observations.md.
export class AddAuditTimestampsToUsersAndCategories1787470000000
  implements MigrationInterface
{
  name = 'AddAuditTimestampsToUsersAndCategories1787470000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "created_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "updated_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" ADD COLUMN "created_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" ADD COLUMN "updated_at" TIMESTAMP NOT NULL DEFAULT now()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "categories" DROP COLUMN "updated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" DROP COLUMN "created_at"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "updated_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "created_at"`);
  }
}
