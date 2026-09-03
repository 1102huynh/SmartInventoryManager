import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdjustmentRequest } from '../adjustments/adjustment-request.entity';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { InventoryService } from '../inventory/inventory.service';
import { Product } from './product.entity';
import { ProductsService } from './products.service';

// This is a unit test, matching suppliers.service.spec.ts's approach: the repository
// and InventoryService are both replaced with fakes, so these tests are fast and
// exercise nothing but ProductsService's own decision-making. The behavior under test
// here — SKU uniqueness, and BR-001's "SKU is locked once history exists" rule — is
// pure application logic (an `if`, then either throw or don't); it doesn't depend on
// anything a mock can't faithfully stand in for (unlike InventoryService's row
// locking, which is why *that* has an integration test instead — see
// docs/learning-notes/testing-strategy.md). There's no concurrency, no real SQL
// behavior, and no transaction to prove here, so a unit test is the right tool, not
// an integration test.
describe('ProductsService', () => {
  let service: ProductsService;
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve({ id: 1, ...v })),
    remove: jest.fn((v) => Promise.resolve(v)),
  };
  const inventoryService = {
    hasHistory: jest.fn(),
  };
  // Phase 12 (BR-089): remove() also checks for a pending adjustment request. Default
  // to zero here; the BR-089 test overrides it.
  const adjustmentRepo = { count: jest.fn().mockResolvedValue(0) };
  const auditService = { record: jest.fn() };
  const ACTOR_ID = 99;

  beforeEach(async () => {
    jest.clearAllMocks();
    adjustmentRepo.count.mockResolvedValue(0);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: repo },
        {
          provide: getRepositoryToken(AdjustmentRequest),
          useValue: adjustmentRepo,
        },
        { provide: InventoryService, useValue: inventoryService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(ProductsService);
  });

  // BR-001: every product is uniquely identified by its SKU. This is also enforced
  // at the database level (a unique index — see product.entity.ts), but that second
  // layer only produces a raw constraint-violation error; this check is what turns it
  // into a clean, predictable 409 before a write is even attempted.
  describe('create — SKU uniqueness', () => {
    it('creates the product when the SKU is not already in use', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.create(
        { name: 'Widget', sku: 'W-1', unit: 'each' },
        ACTOR_ID,
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('rejects creation with ConflictException when the SKU is already taken', async () => {
      repo.findOne.mockResolvedValue({ id: 1, sku: 'W-1' });
      await expect(
        service.create({ name: 'Widget', sku: 'W-1', unit: 'each' }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    // Phase 9 (docs/phase-9-plan.md §2 "each write method records its event with the
    // actor it was passed").
    it('records product_created with the actor and no subject (an inventory item, not an account)', async () => {
      repo.findOne.mockResolvedValue(null);
      const created = await service.create(
        { name: 'Widget', sku: 'W-1', unit: 'each' },
        ACTOR_ID,
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.PRODUCT_CREATED,
          actorUserId: ACTOR_ID,
          entityId: created.id,
        }),
      );
    });
  });

  // BR-001/FR-002: "SKU identity should not be freely changeable once transactions
  // exist" — protects the audit trail (every past InventoryTransaction refers to a
  // product by this identity; changing it out from under existing history would make
  // those records ambiguous). This is the one piece of update() with a real branch to
  // get wrong, which is exactly what review question 4 in phase-2-review.md was
  // probing — these tests are what would have caught it.
  describe('update — SKU change vs. inventory history (BR-001)', () => {
    // A fresh object per test, not a shared const: ProductsService.update mutates the
    // entity it got back from findOne() in place (`product.sku = dto.sku`) before
    // saving it — reusing one object across tests would leak a previous test's
    // mutation into the next one.
    function existingProduct(): Product {
      return {
        id: 1,
        sku: 'W-1',
        name: 'Widget',
        unit: 'each',
        categoryId: null,
        lowStockThreshold: null,
      } as Product;
    }

    it('allows the SKU to change when the product has no inventory history', async () => {
      repo.findOne
        .mockResolvedValueOnce(existingProduct()) // fetch the product being updated
        .mockResolvedValueOnce(null); // assertSkuAvailable: no other product uses 'W-2'
      inventoryService.hasHistory.mockResolvedValue(false);

      await service.update(
        1,
        {
          name: 'Widget',
          unit: 'each',
          sku: 'W-2',
        },
        ACTOR_ID,
      );

      expect(inventoryService.hasHistory).toHaveBeenCalledWith(1);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sku: 'W-2' }),
      );
    });

    it('rejects an SKU change once the product has inventory history', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(true);

      await expect(
        service.update(
          1,
          { name: 'Widget', unit: 'each', sku: 'W-2' },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      // Rejected before ever checking whether 'W-2' itself is free — findOne should
      // only have been called once, to fetch the product.
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('does not treat a no-op SKU update (same value) as a SKU change', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(true); // even with history —

      await service.update(
        1,
        {
          name: 'Widget Renamed',
          unit: 'each',
          sku: 'W-1', // identical to the product's current SKU
        },
        ACTOR_ID,
      );

      // The history check exists to gate an *actual* SKU change — sending the same
      // value back (e.g. a form re-submitting its current state) must not trigger it,
      // even for a product that does have history.
      expect(inventoryService.hasHistory).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sku: 'W-1', name: 'Widget Renamed' }),
      );
    });

    it('does not treat an update that omits sku entirely as a SKU change', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(true); // even with history —

      await service.update(
        1,
        { name: 'Widget Renamed', unit: 'each' },
        ACTOR_ID,
      );

      expect(inventoryService.hasHistory).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ sku: 'W-1' }),
      );
    });
  });

  // Phase 9 (post-review fix): remove() had no coverage at all — the unit layer's
  // job here is to prove the RIGHT thing gets recorded, with the RIGHT actor/entity,
  // after the row is gone; audit.e2e-spec.ts proves the row genuinely survives with
  // no foreign key to enforce otherwise (§1 "entity_id is deliberately NOT a foreign
  // key").
  describe('remove', () => {
    function existingProduct(): Product {
      return {
        id: 1,
        sku: 'W-1',
        name: 'Widget',
        unit: 'each',
        categoryId: null,
        lowStockThreshold: null,
      } as Product;
    }

    it('records product_deleted with the actor, after the row is removed', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(false);

      await service.remove(1, ACTOR_ID);

      expect(repo.remove).toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.PRODUCT_DELETED,
          actorUserId: ACTOR_ID,
          entityId: 1,
          summary: expect.stringContaining('W-1'),
        }),
      );
    });

    it('records nothing when the delete is rejected for having history', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(true);

      await expect(service.remove(1, ACTOR_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repo.remove).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    // BR-089 (Phase 12): a product with no transaction history but a PENDING
    // adjustment request cannot be hard-deleted — the RESTRICT FK would otherwise
    // surface as a 500 on a path a user can reach.
    it('rejects the delete when a pending adjustment request exists, and records nothing', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(false);
      // Both count() calls (total, then pending) see the row.
      adjustmentRepo.count.mockResolvedValue(1);

      const err = await service.remove(1, ACTOR_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/pending adjustment request/i);
      expect(repo.remove).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    // BR-089 (Phase 12): the FK is RESTRICT for every status, so a withdrawn or
    // rejected request against an otherwise-history-free product also blocks the hard
    // delete — with the "deactivate instead" wording, since a resolved request is
    // history in the same sense BR-004 means.
    it('rejects the delete when only a resolved (withdrawn/rejected) request exists', async () => {
      repo.findOne.mockResolvedValueOnce(existingProduct());
      inventoryService.hasHistory.mockResolvedValue(false);
      // Total count sees a row; the pending count is zero.
      adjustmentRepo.count
        .mockResolvedValueOnce(1) // total for this product
        .mockResolvedValueOnce(0); // pending

      const err = await service.remove(1, ACTOR_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/adjustment request history/i);
      expect(repo.remove).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });
});
