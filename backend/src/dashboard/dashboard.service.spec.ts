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
describe('DashboardService', () => {
  let service: DashboardService;
  const repo = { find: jest.fn() };
  const inventoryService = {
    getCurrentStockMap: jest.fn(),
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
      ...overrides,
    } as Product;
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
    const noThreshold = product({ id: 1, lowStockThreshold: null });
    repo.find.mockResolvedValue([noThreshold]);
    inventoryService.getCurrentStockMap.mockResolvedValue(new Map([[1, 0]]));

    const summary = await service.getSummary();

    expect(summary.outOfStockCount).toBe(1);
    expect(summary.needsAttention).toHaveLength(0);
  });

  // Phase 11 (docs/phase-11-plan.md §5): the one place the phase's actual defect — a
  // dashboard that reads the whole transaction table — can be pinned as a regression
  // guard. Cheap, and it goes red if getSummary reverts to `listAll({})`.
  it('reads recent activity with a bounded limit, not the whole table', async () => {
    repo.find.mockResolvedValue([]);
    inventoryService.getCurrentStockMap.mockResolvedValue(new Map());

    await service.getSummary();

    expect(inventoryService.listAll).toHaveBeenCalledWith({ limit: 8 });
    expect(inventoryService.countSince).toHaveBeenCalledWith(7);
  });

  it('includes an out-of-stock product that DOES have a threshold in both counts', async () => {
    const withThreshold = product({ id: 2, lowStockThreshold: 5 });
    repo.find.mockResolvedValue([withThreshold]);
    inventoryService.getCurrentStockMap.mockResolvedValue(new Map([[2, 0]]));

    const summary = await service.getSummary();

    expect(summary.outOfStockCount).toBe(1);
    expect(summary.needsAttention).toHaveLength(1);
    expect(summary.needsAttention[0]).toEqual(
      expect.objectContaining({ id: 2, currentStock: 0 }),
    );
  });
});
