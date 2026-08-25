import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { AuditEvent } from './audit-event.entity';
import { QueryAuditEventsDto } from './dto/query-audit-events.dto';

const DEFAULT_LIMIT = 100;

// The fields a caller supplies to record() — plain ids, never entities. Taking
// entities would pull UsersModule into AuditModule and create a
// UsersModule -> AuditModule -> UsersModule cycle Nest can only be talked out of with
// forwardRef() (docs/phase-9-plan.md §1 "One import-direction constraint that must be
// respected"). Recording by id keeps the dependency graph a DAG for free.
export interface RecordAuditEvent {
  eventType: AuditEventType;
  actorUserId?: number | null;
  subjectUserId?: number | null;
  entityType?: AuditEntityType | null;
  entityId?: number | null;
  summary: string;
  actorIp?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditEvent)
    private readonly auditRepository: Repository<AuditEvent>,
  ) {}

  // Phase 9 (docs/phase-9-plan.md §1 "Recording is best-effort and never fails the
  // request it describes"). The try/catch below is the decision, not an oversight:
  // an Owner must not be unable to deactivate a compromised account because the audit
  // table is full, or because a constraint changed under a deploy. The consequence is
  // BR-082's "a record, not a proof" — a failed write here is logged and swallowed,
  // never rethrown, so a caller of record() can never observe it fail.
  async record(event: RecordAuditEvent): Promise<void> {
    try {
      const row = this.auditRepository.create({
        eventType: event.eventType,
        actorUserId: event.actorUserId ?? null,
        subjectUserId: event.subjectUserId ?? null,
        entityType: event.entityType ?? null,
        entityId: event.entityId ?? null,
        summary: event.summary,
        actorIp: event.actorIp ?? null,
      });
      await this.auditRepository.save(row);
    } catch (err) {
      this.logger.error(
        `Failed to record audit event ${event.eventType}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Newest-first, filtered, capped — no offset pagination (§1 "the cap is not
  // optional here": this table grows without any user doing anything, from every
  // failed login anywhere on the internet). relations on actor/subject so the screen
  // renders names without a second request, the same joined-read choice
  // InventoryService.listAll already made for product/supplier/recordedBy — safe by
  // construction because ClassSerializerInterceptor already strips passwordHash,
  // failedLoginAttempts, and lockedUntil from any nested User (see user.entity.ts).
  findAll(query: QueryAuditEventsDto): Promise<AuditEvent[]> {
    const qb = this.auditRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.actor', 'actor')
      .leftJoinAndSelect('event.subject', 'subject')
      .orderBy('event.id', 'DESC')
      .take(query.limit ?? DEFAULT_LIMIT);

    if (query.eventType)
      qb.andWhere('event.eventType = :eventType', {
        eventType: query.eventType,
      });
    if (query.actorUserId)
      qb.andWhere('event.actorUserId = :actorUserId', {
        actorUserId: query.actorUserId,
      });
    if (query.subjectUserId)
      qb.andWhere('event.subjectUserId = :subjectUserId', {
        subjectUserId: query.subjectUserId,
      });
    if (query.days) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - query.days);
      qb.andWhere('event.createdAt >= :cutoff', { cutoff });
    }
    return qb.getMany();
  }
}
