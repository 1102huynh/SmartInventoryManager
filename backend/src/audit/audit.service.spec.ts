import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { AuditEvent } from './audit-event.entity';
import { AuditService } from './audit.service';

// Unit test, same shape as suppliers.service.spec.ts: the repository is replaced with
// a fake. The property that matters most here — a failed write never propagates — has
// no other test anywhere in the suite that would catch its loss (docs/phase-9-plan.md
// §5): a future refactor that removes the try/catch passes every other test in the
// app while turning every audit failure into a 500 on, say, a user's password reset.
describe('AuditService', () => {
  let service: AuditService;
  const repo = {
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve({ id: 1, ...v })),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditEvent), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(AuditService);
  });

  describe('record', () => {
    it('persists the given event type, actor, subject, entity, and summary', async () => {
      await service.record({
        eventType: AuditEventType.USER_UPDATED,
        actorUserId: 1,
        subjectUserId: 2,
        entityType: AuditEntityType.USER,
        entityId: 2,
        summary: 'Role changed from staff to owner',
      });
      expect(repo.create).toHaveBeenCalledWith({
        eventType: AuditEventType.USER_UPDATED,
        actorUserId: 1,
        subjectUserId: 2,
        entityType: AuditEntityType.USER,
        entityId: 2,
        summary: 'Role changed from staff to owner',
        actorIp: null,
      });
      expect(repo.save).toHaveBeenCalled();
    });

    it('defaults every optional field to null', async () => {
      await service.record({
        eventType: AuditEventType.LOGIN_FAILED,
        summary: 'Unknown email',
      });
      expect(repo.create).toHaveBeenCalledWith({
        eventType: AuditEventType.LOGIN_FAILED,
        actorUserId: null,
        subjectUserId: null,
        entityType: null,
        entityId: null,
        summary: 'Unknown email',
        actorIp: null,
      });
    });

    // The best-effort property (§1 "Recording is best-effort and never fails the
    // request it describes"): a repository failure must not propagate.
    it('does not throw when the repository save rejects', async () => {
      repo.save.mockRejectedValueOnce(new Error('connection lost'));
      await expect(
        service.record({
          eventType: AuditEventType.LOGIN_SUCCEEDED,
          subjectUserId: 1,
          summary: 'Login succeeded',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('findAll', () => {
    function makeQb() {
      const qb: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      repo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('applies each filter it is given', async () => {
      const qb = makeQb();
      await service.findAll({
        eventType: AuditEventType.LOGIN_FAILED,
        actorUserId: 1,
        subjectUserId: 2,
        days: 7,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('event.eventType = :eventType', {
        eventType: AuditEventType.LOGIN_FAILED,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('event.actorUserId = :actorUserId', {
        actorUserId: 1,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'event.subjectUserId = :subjectUserId',
        { subjectUserId: 2 },
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        'event.createdAt >= :cutoff',
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
    });

    it('defaults the limit to 100 and respects an explicit limit', async () => {
      const qb = makeQb();
      await service.findAll({});
      expect(qb.take).toHaveBeenCalledWith(100);

      const qb2 = makeQb();
      await service.findAll({ limit: 2 });
      expect(qb2.take).toHaveBeenCalledWith(2);
    });

    it('orders newest first', async () => {
      const qb = makeQb();
      await service.findAll({});
      expect(qb.orderBy).toHaveBeenCalledWith('event.id', 'DESC');
    });
  });
});
