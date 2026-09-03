import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AdjustmentRequestStatus } from '../common/enums/adjustment-request-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { InventoryService } from '../inventory/inventory.service';
import { Product } from '../products/product.entity';
import { AdjustmentRequest } from './adjustment-request.entity';
import { AdjustmentsService } from './adjustments.service';

// A UNIT test: repositories, the DataSource, and InventoryService are all fakes. It
// covers the parts of the state machine that are decided BEFORE any database
// transaction is opened — the 403/404/409/400 gates (§5 "most of the new behaviour is
// a state machine, and state machines fail at their edges"). The delta computation,
// atomicity, and locking are covered against real Postgres in
// adjustments.service.integration.spec.ts, because a mock cannot prove them.
describe('AdjustmentsService (unit — the resolve() gates)', () => {
  let service: AdjustmentsService;

  const requestsRepo = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
  const productsRepo = { findOne: jest.fn() };
  const inventoryService = {
    assertNotFuture: jest.fn(),
    recordAdjustment: jest.fn(),
    getCurrentStock: jest.fn(),
    applyApprovedAdjustment: jest.fn(),
  };
  // If a gate test ever reaches the transaction, that is itself a failure — the point
  // is that these rejections happen without touching the database.
  const dataSource = {
    transaction: jest.fn(() => {
      throw new Error(
        'resolve() opened a transaction on a path that should have been rejected first',
      );
    }),
  };

  const OWNER = { id: 1, role: UserRole.Owner };
  const OTHER_OWNER = { id: 2, role: UserRole.Owner };
  const STAFF_REQUESTER = { id: 3, role: UserRole.Staff };
  const OTHER_STAFF = { id: 4, role: UserRole.Staff };

  function pendingRequest(
    overrides: Partial<AdjustmentRequest> = {},
  ): AdjustmentRequest {
    return {
      id: 10,
      productId: 100,
      newQuantity: 40,
      occurredAt: new Date('2026-08-02'),
      reason: 'Stocktake',
      status: AdjustmentRequestStatus.PENDING,
      requestedByUserId: STAFF_REQUESTER.id,
      stockAtRequest: 35,
      resolvedByUserId: null,
      resolutionReason: null,
      resultingTransactionId: null,
      ...overrides,
    } as AdjustmentRequest;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    dataSource.transaction.mockImplementation(() => {
      throw new Error(
        'resolve() opened a transaction on a path that should have been rejected first',
      );
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdjustmentsService,
        {
          provide: getRepositoryToken(AdjustmentRequest),
          useValue: requestsRepo,
        },
        { provide: getRepositoryToken(Product), useValue: productsRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: InventoryService, useValue: inventoryService },
      ],
    }).compile();
    service = moduleRef.get(AdjustmentsService);
  });

  it('404s an unknown request', async () => {
    requestsRepo.findOne.mockResolvedValue(null);
    await expect(
      service.resolve(999, { status: AdjustmentRequestStatus.APPROVED }, OWNER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s a request that is no longer pending — no silent second resolution', async () => {
    requestsRepo.findOne.mockResolvedValue(
      pendingRequest({ status: AdjustmentRequestStatus.APPROVED }),
    );
    await expect(
      service.resolve(
        10,
        { status: AdjustmentRequestStatus.REJECTED, reason: 'no' },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('403s Staff trying to approve', async () => {
    requestsRepo.findOne.mockResolvedValue(pendingRequest());
    await expect(
      service.resolve(
        10,
        { status: AdjustmentRequestStatus.APPROVED },
        OTHER_STAFF,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403s an Owner approving their OWN promoted-from-Staff request (no self-approval)', async () => {
    // The requester was Staff #3; they have since been promoted to Owner and now hold
    // an Owner token with id 3. They must still not approve their own request.
    requestsRepo.findOne.mockResolvedValue(
      pendingRequest({ requestedByUserId: 3 }),
    );
    await expect(
      service.resolve(
        10,
        { status: AdjustmentRequestStatus.APPROVED },
        { id: 3, role: UserRole.Owner },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a DIFFERENT Owner approve (delegates to InventoryService inside a transaction)', async () => {
    requestsRepo.findOne.mockResolvedValue(pendingRequest());
    requestsRepo.findOneOrFail.mockResolvedValue(
      pendingRequest({ status: AdjustmentRequestStatus.APPROVED }),
    );
    dataSource.transaction.mockImplementation((cb: (m: unknown) => unknown) => {
      const managerRepo = {
        findOne: jest.fn().mockResolvedValue(pendingRequest()),
        save: jest.fn(),
      };
      return cb({ getRepository: () => managerRepo });
    });
    inventoryService.applyApprovedAdjustment.mockResolvedValue({ id: 555 });

    await service.resolve(
      10,
      { status: AdjustmentRequestStatus.APPROVED },
      OTHER_OWNER,
    );

    expect(inventoryService.applyApprovedAdjustment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productId: 100,
        newQuantity: 40,
        userId: STAFF_REQUESTER.id,
      }),
    );
  });

  it('403s a non-requester Staff trying to withdraw', async () => {
    requestsRepo.findOne.mockResolvedValue(pendingRequest());
    await expect(
      service.resolve(
        10,
        { status: AdjustmentRequestStatus.WITHDRAWN, reason: 'oops' },
        OTHER_STAFF,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('400s a rejection with no reason', async () => {
    requestsRepo.findOne.mockResolvedValue(pendingRequest());
    await expect(
      service.resolve(10, { status: AdjustmentRequestStatus.REJECTED }, OWNER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s a withdrawal with no reason', async () => {
    requestsRepo.findOne.mockResolvedValue(pendingRequest());
    await expect(
      service.resolve(
        10,
        { status: AdjustmentRequestStatus.WITHDRAWN },
        STAFF_REQUESTER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('submit()', () => {
    it('records immediately for an Owner (delegates to InventoryService.recordAdjustment)', async () => {
      inventoryService.recordAdjustment.mockResolvedValue({
        id: 1,
        quantityDelta: -5,
      });
      const result = await service.submit(
        100,
        { newQuantity: 5, occurredAt: '2026-08-02', reason: 'r' },
        OWNER,
      );
      expect(result).toEqual({
        outcome: 'recorded',
        transaction: { id: 1, quantityDelta: -5 },
      });
      expect(inventoryService.recordAdjustment).toHaveBeenCalled();
    });

    it('creates a pending request for Staff, snapshotting the stock they saw', async () => {
      productsRepo.findOne.mockResolvedValue({ id: 100 });
      inventoryService.getCurrentStock.mockResolvedValue(35);
      requestsRepo.create.mockImplementation((v) => v);
      requestsRepo.save.mockResolvedValue({ id: 77 });
      requestsRepo.findOneOrFail.mockResolvedValue({
        id: 77,
        status: 'pending',
      });

      const result = await service.submit(
        100,
        { newQuantity: 40, occurredAt: '2026-08-02', reason: 'Stocktake' },
        STAFF_REQUESTER,
      );

      expect(result.outcome).toBe('requested');
      expect(requestsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stockAtRequest: 35,
          requestedByUserId: STAFF_REQUESTER.id,
        }),
      );
    });

    it('404s a Staff submission against a missing product', async () => {
      productsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.submit(
          404,
          { newQuantity: 1, occurredAt: '2026-08-02', reason: 'r' },
          STAFF_REQUESTER,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
