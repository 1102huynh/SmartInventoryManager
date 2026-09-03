import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 12 (docs/phase-12-plan.md §2). One new table, nothing else: no new column, no
// new constraint, and no new index on inventory_transactions — Fork A's whole storage
// claim. Additive, like Phase 9's and Phase 11's migrations and unlike Phase 10's
// converting one — down() drops the table and the type and loses nothing.
//
// Sorts after 1787830000000-AddInventoryTransactionsOccurredAtIndex.
//
// Notes a reviewer will check:
//  - Every timestamp is timestamptz. domain-model.md §8 names a type as of Phase 10,
//    and this is the first table created since. created_at AND updated_at, because
//    these rows are mutable (the fourth mutable table).
//  - CHK_adjustment_requests_resolution encodes the state machine in the schema — a
//    bug or a direct SQL script cannot produce an approved request with no approver,
//    or a rejection with no reason. Same spirit as inventory_transactions' @Check set.
//  - resulting_transaction_id is a real FK with RESTRICT, safe because
//    inventory_transactions rows are never deleted (BR-051).
//  - IDX_adjustment_requests_status exists because the pending queue
//    (WHERE status = 'pending') is the screen an Owner opens — the one filter with a
//    strongly skewed distribution. Phase 11 §7's "indexing anything else" caution
//    applies to everything not listed here: product_id is NOT indexed (`?productId=`
//    and remove()'s count are both rare, and the table stays small), and the entity
//    declares no @Index on the product relation either, so all three registries agree.
//  - Covers smart_inventory and smart_inventory_e2e; the entity declaration covers
//    smart_inventory_test (synchronize: true) — same two indexes (the only difference
//    is the created_at/id composite's ASC-vs-DESC, the caveat the entity comment names).
export class AddAdjustmentRequests1787920000000 implements MigrationInterface {
  name = 'AddAdjustmentRequests1787920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "adjustment_requests_status_enum" AS ENUM
        ('pending', 'approved', 'rejected', 'withdrawn')
    `);
    await queryRunner.query(`
      CREATE TABLE "adjustment_requests" (
        "id"                       SERIAL PRIMARY KEY,
        "product_id"               INTEGER NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
        "new_quantity"             INTEGER NOT NULL CHECK ("new_quantity" >= 0),
        "occurred_at"              TIMESTAMPTZ NOT NULL,
        "reason"                   TEXT NOT NULL CHECK ("reason" <> ''),
        "status"                   "adjustment_requests_status_enum" NOT NULL DEFAULT 'pending',
        "requested_by_user_id"     INTEGER NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "stock_at_request"         INTEGER NOT NULL,
        "resolved_by_user_id"      INTEGER NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "resolution_reason"        TEXT NULL,
        "resulting_transaction_id" INTEGER NULL REFERENCES "inventory_transactions"("id") ON DELETE RESTRICT,
        "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_adjustment_requests_resolution" CHECK (
          ("status" = 'pending'  AND "resolved_by_user_id" IS NULL
                                 AND "resulting_transaction_id" IS NULL)
          OR ("status" = 'approved' AND "resolved_by_user_id" IS NOT NULL
                                    AND "resulting_transaction_id" IS NOT NULL)
          OR ("status" IN ('rejected', 'withdrawn')
                AND "resolved_by_user_id" IS NOT NULL
                AND "resulting_transaction_id" IS NULL
                AND "resolution_reason" IS NOT NULL AND "resolution_reason" <> '')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_adjustment_requests_created_at_id"
        ON "adjustment_requests" ("created_at" DESC, "id" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_adjustment_requests_status"
        ON "adjustment_requests" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "adjustment_requests"`); // takes its indexes with it
    await queryRunner.query(`DROP TYPE "adjustment_requests_status_enum"`);
  }
}
