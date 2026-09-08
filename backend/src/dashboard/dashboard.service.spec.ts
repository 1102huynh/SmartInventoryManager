import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { InventoryService } from '../inventory/inventory.service';
import { Product } from '../products/product.entity';
import { DashboardService } from './dashboard.service';

// BR-062: this test exists specifically to lock in the previously-ambiguous decision
// about what "needs attention" means — an out-of-stock product with no configured
// threshold must still count toward outOfStockCount, but must NOT appear in
// needsAttention (see docs/business-rules.md BR-062 for the reasoning). Everything
// else DashboardService does is thin composition of two other services' data, not
// worth a dedicated test on its own.
//
// Phase 19 (docs/phase-19-plan.md §1) moved the stock counts into one products query.
// Phase 23 (docs/phase-23-plan.md §1 Fork C): current stock is a materialised column
// now, so getSummary is back to a plain `productsRepository.find({ order })` — the
// grouped-subquery join and its `getRawAndEntities` plumbing are gone. The repo `find`
// is faked here; dashboard.service.integration.spec.ts proves the column is right
// against a real database. `getCurrentStockMap` is deliberately absent from the
// InventoryService fake below — if getSummary called it, these tests would throw.
describe('DashboardService', () => {
  let service: DashboardService;

  const repo = { find: jest.fn() };

  const inventoryService = {
    // Phase 11 (docs/phase-11-plan.md §2): listAll returns { rows, truncated } now,
    // and the 7-day count comes from a dedicated countSince rather than a second
    // full read.
    listAll: jest.fn().mockResolvedValue({ rows: [], truncated: false }),
    countSince: jest.fn().mockResolvedValue(0),
  };

  function product(overrides: Partial<Product>): Product {
    return {
      id: 1,
      sku: 'SKU',
      name: 'Product',
      unit: 'each',
      categoryId: null,
      lowStockThreshold: null,
      status: EntityStatus.ACTIVE,
      currentStock: 0,
      ...overrides,
    } as Product;
  }

  // getSummary reads `products.current_stock` straight off each entity now.
  function withProducts(products: Product[]): void {
    repo.find.mockResolvedValue(products);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    inventoryService.listAll.mockResolvedValue({ rows: [], truncated: false });
    inventoryService.countSince.mockResolvedValue(0);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: getRepositoryToken(Product), useValue: repo },
        { provide: InventoryService, useValue: inventoryService },
      ],
    }).compile();
    service = moduleRef.get(DashboardService);
  });

  it('counts an out-of-stock product with no threshold in outOfStockCount but excludes it from needsAttention', async () => {
    withProducts([
      product({ id: 1, lowStockThreshold: null, currentStock: 0 }),
    ]);

    const summary = await service.getSummary();

    expect(summary.outOfStockCount).toBe(1);
    expect(summary.needsAttention).toHaveLength(0);
  });

  // Phase 11 (docs/phase-11-plan.md §5): the one place the phase's actual defect — a
  // dashboard that reads the whole transaction table — can be pinned as a regression
  // guard. Cheap, and it goes red if getSummary reverts to `listAll({})`.
  //
  // Phase 19 / 23: also the guard for the read shape — the stock counts come from a
  // single `find`, name-ordered, and no per-product aggregate round-trip is fired.
  it('reads recent activity with a bounded limit, and reads products in one name-ordered query', async () => {
    withProducts([]);

    await service.getSummary();

    expect(inventoryService.listAll).toHaveBeenCalledWith({ limit: 8 });
    expect(inventoryService.countSince).toHaveBeenCalledWith(7);
    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(repo.find).toHaveBeenCalledWith({ order: { name: 'ASC' } });
  });

  it('includes an out-of-stock product that DOES have a threshold in both counts', async () => {
    withProducts([product({ id: 2, lowStockThreshold: 5, currentStock: 0 })]);

    const summary = await service.getSummary();

    expect(summary.outOfStockCount).toBe(1);
    expect(summary.needsAttention).toHaveLength(1);
    expect(summary.needsAttention[0]).toEqual(
      expect.objectContaining({ id: 2, currentStock: 0 }),
    );
  });
});
