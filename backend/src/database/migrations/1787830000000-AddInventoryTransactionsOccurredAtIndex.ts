import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 11 (docs/phase-11-plan.md §1 "The index Phase 9 added and Phase 2 never did").
// Both transaction log reads ORDER BY occurred_at DESC and both gain a LIMIT in this
// phase; ?days= filters on the same column. inventory_transactions has carried exactly
// one index since InitSchema — on product_id — so today that ordering is a full scan
// plus a sort, and a LIMIT on top of it reduces what crosses the wire without reducing
// any work Postgres does.
//
// The composite (occurred_at DESC, id DESC) is not a hedge: it is the exact ordering
// §1 requires. occurred_at comes from <input type="date">, so every transaction on one
// business day is byte-identical in that column and the sort is not total without the
// primary key appended. Indexing only occurred_at would leave Postgres sorting the ties.
//
// Additive, unlike Phase 10's converting migration: down() drops the index and loses
// nothing. CREATE INDEX, not CONCURRENTLY — TypeORM runs migrations inside a
// transaction, which CONCURRENTLY cannot join, and at this table's size the lock is
// milliseconds.
export class AddInventoryTransactionsOccurredAtIndex1787830000000 implements MigrationInterface {
  name = 'AddInventoryTransactionsOccurredAtIndex1787830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_inventory_transactions_occurred_at_id" ON "inventory_transactions" ("occurred_at" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_inventory_transactions_occurred_at_id"`,
    );
  }
}
