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
    const products = await this.productsRepository.find();
    const stockMap = await this.inventoryService.getCurrentStockMap(
      products.map((p) => p.id),
    );

    const activeProducts = products.filter(
      (p) => p.status === EntityStatus.ACTIVE,
    );
    const lowStockProducts = products.filter((p) => {
      if (p.lowStockThreshold === null) return false;
      return (stockMap.get(p.id) ?? 0) <= p.lowStockThreshold;
    });
    const outOfStockProducts = products.filter(
      (p) => (stockMap.get(p.id) ?? 0) <= 0,
    );

    const recentTransactions = await this.inventoryService.listAll({});
    const last7DaysTransactions = await this.inventoryService.listAll({
      days: 7,
    });

    return {
      activeProductsCount: activeProducts.length,
      inactiveProductsCount: products.length - activeProducts.length,
      lowStockCount: lowStockProducts.length,
      outOfStockCount: outOfStockProducts.length,
      transactionsLast7Days: last7DaysTransactions.length,
      recentActivity: recentTransactions.slice(0, 8),
      needsAttention: lowStockProducts
        .map((p) => ({ ...p, currentStock: stockMap.get(p.id) ?? 0 }))
        .slice(0, 5),
    };
  }
}
