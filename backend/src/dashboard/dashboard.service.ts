import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { InventoryService } from '../inventory/inventory.service';
import { Product } from '../products/product.entity';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly inventoryService: InventoryService,
  ) {}

  // FR-050: this method fetches from Product and Inventory and combines the results —
  // it does not introduce any new data of its own, matching the domain model's framing
  // of the dashboard as a pure read-side composition, not a fourth domain.
  async getSummary() {
    // Phase 19 (docs/phase-19-plan.md §1) collapsed this method's two round-trips
    // (`productsRepository.find()` + `inventoryService.getCurrentStockMap()`) into one
    // query with a grouped-subquery `SUM`. Phase 23 (docs/phase-23-plan.md §1 Fork C):
    // that `SUM` is a stored column now, so this is a plain `find()` again — the
    // `joinCurrentStock` helper and the `getRawAndEntities` / `raw[i]` alignment are
    // gone. The whole-catalogue read stays: a summary that reports `lowStockCount`
    // inherently needs every product, so it is not a paging problem (Phase 14 §7).
    //
    // `ORDER BY name ASC` is kept (added in Phase 19): without it, which five products
    // land in `needsAttention` when more than five are low-stock is whatever order the
    // executor produces. Ordering by name makes it deterministic and matches `findAll`
    // — the same determinism improvement Phase 11 made for `recentActivity`.
    const products = await this.productsRepository.find({
      order: { name: 'ASC' },
    });

    const activeProducts = products.filter(
      (p) => p.status === EntityStatus.ACTIVE,
    );
    const lowStockProducts = products.filter((p) => {
      if (p.lowStockThreshold === null) return false;
      return p.currentStock <= p.lowStockThreshold;
    });
    const outOfStockProducts = products.filter((p) => p.currentStock <= 0);

    // Phase 11 (docs/phase-11-plan.md §2 "the actual win"): opening the dashboard used
    // to be O(whole transaction history), twice — listAll({}) materialised the entire
    // joined table to keep 8 rows, and listAll({ days: 7 }) materialised the 7-day
    // window to read nothing but .length. Now: 9 rows fetched, and one COUNT(*).
    //
    // recentActivity is equivalent to the old result on tie-free data. Where rows
    // share an occurred_at at the 8-row boundary the two can differ: the old
    // slice(0, 8) took whatever order the executor happened to produce for
    // `ORDER BY occurred_at DESC` (execution-plan-dependent, not guaranteed), while
    // `ORDER BY occurred_at DESC, id DESC LIMIT 8` is deterministic — newest-inserted
    // first among a tie. So this is a determinism *improvement*, not merely preserved
    // behaviour (§1, §2).
    const recent = await this.inventoryService.listAll({ limit: 8 });
    const transactionsLast7Days = await this.inventoryService.countSince(7);

    return {
      activeProductsCount: activeProducts.length,
      inactiveProductsCount: products.length - activeProducts.length,
      lowStockCount: lowStockProducts.length,
      outOfStockCount: outOfStockProducts.length,
      transactionsLast7Days,
      recentActivity: recent.rows,
      // BR-062: needsAttention is deliberately the low-stock list only, not low-stock
      // + out-of-stock merged. A product with no threshold configured is out of stock
      // "silently" here (still counted in outOfStockCount above) — that's BR-061
      // ("never flagged low-stock without a threshold") applied consistently, not a
      // gap. See docs/business-rules.md BR-062 for the full reasoning. Each row
      // already carries `currentStock` from the query above.
      needsAttention: lowStockProducts.slice(0, 5),
    };
  }
}
