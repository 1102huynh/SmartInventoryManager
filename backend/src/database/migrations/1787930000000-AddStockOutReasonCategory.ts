import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 18 (docs/phase-18-plan.md), resolving product.md Q-4. Gives stock-out a
// structured reason: inventory_transactions.reason_category, its own per-table
// Postgres enum — the same pattern InitSchema used for
// inventory_transactions_type_enum and AddUserRoleEnum/AddUserStatus followed for
// users.role / users.status.
//
// Add-nullable, and that's the whole story — unlike AddUserStatus this column is
// *meant* to stay nullable: a stock-out recorded before this phase, or one recorded
// without picking a category (FR-021 is untouched — the reason has always been
// optional), legitimately has no category. So there is NO backfill and NO
// SET NOT NULL. Safe against the seeded dev database and an empty one alike.
//
// The CHECK mirrors the "supplier only on stock-in" constraint InitSchema created:
// a reason category is only meaningful on a stock_out row. Its name here is
// hand-written; the test database (test-data-source.ts, synchronize: true) builds the
// same constraint from the entity's @Check decorator under a generated CHK_<hash>
// name — the expected three-registries difference the entity's @Index comment
// already documents, not a drift bug.
export class AddStockOutReasonCategory1787930000000 implements MigrationInterface {
  name = 'AddStockOutReasonCategory1787930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."inventory_transactions_reason_category_enum" AS ENUM('sale', 'internal_use', 'damaged', 'lost', 'expired', 'return', 'other')`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" ADD COLUMN "reason_category" "public"."inventory_transactions_reason_category_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" ADD CONSTRAINT "CHK_inventory_transactions_reason_category_stock_out" CHECK (type = 'stock_out' OR reason_category IS NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" DROP CONSTRAINT "CHK_inventory_transactions_reason_category_stock_out"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" DROP COLUMN "reason_category"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."inventory_transactions_reason_category_enum"`,
    );
  }
}
