import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { CategoriesService } from './categories.service';
import { Category } from './category.entity';

// Unit test, same shape as products.service.spec.ts: the repository is replaced with
// a fake, so this exercises nothing but CategoriesService's own decision-making — the
// name-uniqueness check (mirroring ProductsService.assertSkuAvailable) and remove()'s
// deliberate lack of a hasHistory-style guard (see phase-4-plan.md §1 "Delete is a
// real delete"). No concurrency, no real SQL, no transaction to prove — a unit test
// is the right tool here, not an integration test.
describe('CategoriesService', () => {
  let service: CategoriesService;
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve({ id: 1, ...v })),
    remove: jest.fn((v) => Promise.resolve(v)),
  };
  const auditService = { record: jest.fn() };
  const ACTOR_ID = 99;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: getRepositoryToken(Category), useValue: repo },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(CategoriesService);
  });

  describe('create — name uniqueness', () => {
    it('creates the category when the name is not already in use', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.create({ name: 'Beverages' }, ACTOR_ID);
      expect(repo.save).toHaveBeenCalled();
    });

    it('rejects creation with ConflictException when the name is already taken', async () => {
      repo.findOne.mockResolvedValue({ id: 1, name: 'Beverages' });
      await expect(
        service.create({ name: 'Beverages' }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    // Phase 9 (docs/phase-9-plan.md §2 "each write method records its event with the
    // actor it was passed").
    it('records category_created with the actor', async () => {
      repo.findOne.mockResolvedValue(null);
      const created = await service.create({ name: 'Beverages' }, ACTOR_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.CATEGORY_CREATED,
          actorUserId: ACTOR_ID,
          entityId: created.id,
        }),
      );
    });
  });

  describe('update', () => {
    it('rejects when the target category does not exist', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update(99, { name: 'Beverages' }, ACTOR_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('only re-checks name availability when the name is actually changing', async () => {
      // Mirrors ProductsService.update's "no-op submit shouldn't trip the guard" test
      // for SKU — resubmitting the same name (e.g. a form re-posting its current
      // state) must not run the uniqueness check at all.
      repo.findOne.mockResolvedValueOnce({ id: 1, name: 'Beverages' }); // fetch
      await service.update(1, { name: 'Beverages' }, ACTOR_ID);
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Beverages' }),
      );
      // No-op update: nothing actually changed, so nothing to record.
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('re-checks name availability and rejects when renaming to a name already in use', async () => {
      repo.findOne
        .mockResolvedValueOnce({ id: 1, name: 'Beverages' }) // fetch the category being updated
        .mockResolvedValueOnce({ id: 2, name: 'Snacks' }); // assertNameAvailable: taken
      await expect(
        service.update(1, { name: 'Snacks' }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('renames when the new name is free, and records category_updated', async () => {
      repo.findOne
        .mockResolvedValueOnce({ id: 1, name: 'Beverages' })
        .mockResolvedValueOnce(null);
      await service.update(1, { name: 'Snacks' }, ACTOR_ID);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Snacks' }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.CATEGORY_UPDATED,
          actorUserId: ACTOR_ID,
          entityId: 1,
        }),
      );
    });
  });

  describe('remove', () => {
    it('rejects when the target category does not exist', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.remove(99, ACTOR_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // §1 "Delete is a real delete, not a soft-delete-with-history-guard": asserting
    // that findOne is called exactly once (only the existence lookup, nothing else)
    // is itself the point — it's the test that would catch someone "helpfully" adding
    // a hasHistory-style pre-check that contradicts the ON DELETE SET NULL design.
    it('deletes without any history/usage pre-check', async () => {
      const category = { id: 1, name: 'Beverages' };
      repo.findOne.mockResolvedValueOnce(category);
      await service.remove(1, ACTOR_ID);
      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(repo.remove).toHaveBeenCalledWith(category);
    });

    // §1 "entity_id is deliberately NOT a foreign key": the audit row is written
    // with the category's id even though the row is already gone by that point.
    it('records category_deleted with the actor, after the row is removed', async () => {
      const category = { id: 1, name: 'Beverages' };
      repo.findOne.mockResolvedValueOnce(category);
      await service.remove(1, ACTOR_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.CATEGORY_DELETED,
          actorUserId: ACTOR_ID,
          entityId: 1,
        }),
      );
    });
  });
});
