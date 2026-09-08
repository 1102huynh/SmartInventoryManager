import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 23 (docs/phase-23-plan.md), issue #13. Materialises current stock as a stored
// column on `products` instead of a `SUM(quantity_delta)` over the whole of
// `inventory_transactions` on every catalogue and dashboard read — the successor
// Phase 11 §7 named ("materialising current stock … later, for a measured reason") and
// Phase 14 Fork B / Phase 19 each re-parked. The trigger is Phase 22's: a read whose
// cost is a function of how long the business has run is unbounded, and
// `inventory_transactions` — unlike `audit_events` — cannot be pruned (BR-050/BR-051),
// so the only fix is to stop aggregating it on read.
//
// NOT NULL DEFAULT 0: "unknown stock" is not a valid state (BR-040 — current stock is
// always a defined number), and a product with no transactions is at 0, not null (the
// same COALESCE decision the old read-side CURRENT_STOCK_EXPR encoded). The default is
// correct, not a placeholder, so ProductsService.create needs no change — it is kept
// after the backfill.
//
// The backfill is the exact expression InventoryService.insertTransaction now runs on
// every write and run-seed.ts runs after seeding history — one SUM(quantity_delta) per
// product — so a fresh migration:run against the seeded dev database produces the
// numbers the Phase 1 mockup and every existing test already expect. BR-042's
// "current stock always replays from history" holds by construction: the column is
// only ever rewritten from history, never patched incrementally (BR-043).
//
// No new entity, so the three registries (database.module.ts, data-source.ts,
// test-data-source.ts) are untouched; only product.entity.ts gains the @Column. The
// test database (synchronize: true) builds the column from that decorator.
export class AddProductsCurrentStock1788100000000 implements MigrationInterface {
  name = 'AddProductsCurrentStock1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ADD COLUMN "current_stock" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `UPDATE "products"
          SET "current_stock" = COALESCE(
            (SELECT SUM("tx"."quantity_delta")
               FROM "inventory_transactions" "tx"
              WHERE "tx"."product_id" = "products"."id"), 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "current_stock"`,
    );
  }
}
