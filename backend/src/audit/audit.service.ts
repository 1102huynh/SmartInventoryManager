import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { daysCutoffForInstantColumn } from '../common/days-cutoff';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { BoundedResult, trimToLimit } from '../common/result-truncated.header';
import { AuditEvent } from './audit-event.entity';
import { QueryAuditEventsDto } from './dto/query-audit-events.dto';

const DEFAULT_LIMIT = 100;

// Phase 22 (docs/phase-22-plan.md), issue #12. `audit_events` grows without any user
// acting — every login attempt, anonymous ones included, writes a row, which is the
// reason GET /audit-events was capped back in Phase 9 (§1 "the cap is not optional
// here"). Phase 9 §7 named both the answer and a concrete trigger: "a scheduled
// DELETE FROM audit_events WHERE created_at < now() - interval '1 year'", out of scope
// then only because "this project has no scheduler of any kind." The trigger is now
// met; the scheduler is still declined (@nestjs/schedule was refused in Phase 12 and
// again in Phase 21 Fork C2, pg_cron in Phase 21 §7). Instead the prune piggybacks on
// record() exactly the way Phase 21's throttle_hits sweep piggybacks on increment():
// one call in RETENTION_SWEEP_PROBABILITY also fires it, plus a one-shot on startup.
const RETENTION_DAYS = 365;

// The same rate postgres-throttler.storage.ts sweeps at. record() runs on every login
// attempt and every administrative write, so even at one in a thousand the prune runs
// many times a day on a live system — rare enough to be free on average, frequent
// enough that the table stays trimmed with no scheduler. A constant, not config
// (docs/phase-22-plan.md §1 Fork A): Phase 9 §7 just said "1 year", no deployment
// tunes a retention window here, and no test needs to vary it (a test backdates
// `created_at` directly rather than waiting a year).
const RETENTION_SWEEP_PROBABILITY = 0.001;

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
export class AuditService implements OnApplicationBootstrap {
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
    // Phase 22 (docs/phase-22-plan.md §1): opportunistically trim the table to the
    // retention window. Outside the try/catch above and fire-and-forget with its own
    // swallowed errors — a failed prune must never fail the operation record()
    // describes, the same best-effort shape as the write itself (BR-082) and Phase
    // 21's throttle sweep. Runs even after a failed save, so a table that is failing
    // writes because it is full still gets trimmed.
    this.maybePrune();
  }

  // Fork C4 (docs/phase-21-plan.md §1, reused): clear whatever aged past the window
  // while this process was down, once, at startup — so a long-stopped instance does
  // not have to wait for the probabilistic path to catch up. Errors are logged and
  // swallowed: a prune that fails must not stop the app from booting.
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.pruneToRetentionWindow();
    } catch (err) {
      this.logger.warn(
        `audit_events startup prune failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private maybePrune(): void {
    if (Math.random() >= RETENTION_SWEEP_PROBABILITY) return;
    void this.pruneToRetentionWindow().catch((err: unknown) => {
      this.logger.warn(
        `audit_events prune failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // One bulk, time-based DELETE — it never names or hand-picks an individual row, so
  // the log stays append-only in *shape* (nothing in this app edits a row or deletes
  // a chosen one) while being bounded in *age*. BR-082/BR-090. Uses
  // IDX_audit_events_created_at (Phase 9); `created_at` is timestamptz (Phase 10), so
  // `now()` minus the interval is zone-correct with no schema change and no migration.
  private async pruneToRetentionWindow(): Promise<void> {
    await this.auditRepository.query(
      `DELETE FROM audit_events WHERE created_at < now() - ($1::int * interval '1 day')`,
      [RETENTION_DAYS],
    );
  }

  // Newest-first, filtered, capped — no offset pagination (§1 "the cap is not
  // optional here": this table grows without any user doing anything, from every
  // failed login anywhere on the internet). relations on actor/subject so the screen
  // renders names without a second request, the same joined-read choice
  // InventoryService.listAll already made for product/supplier/recordedBy — safe by
  // construction because ClassSerializerInterceptor already strips passwordHash,
  // failedLoginAttempts, and lockedUntil from any nested User (see user.entity.ts).
  //
  // Phase 11 (docs/phase-11-plan.md §1 "Truncation has to be observable"): this route
  // has been silently truncating since Phase 9. It now returns { rows, truncated } the
  // same way InventoryService's two log reads do, and AuditController sets the same
  // X-Result-Truncated header — leaving the older capped route as the only silent one
  // would make the convention this phase writes down false on the day it is written.
  // The probe is `limit + 1`: ask for one more than we return, and if it comes back,
  // more rows matched. `event.id DESC` was already a total order, so unlike the
  // transaction reads this route needed no tie-break added.
  async findAll(
    query: QueryAuditEventsDto,
  ): Promise<BoundedResult<AuditEvent>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const qb = this.auditRepository
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.actor', 'actor')
      .leftJoinAndSelect('event.subject', 'subject')
      .orderBy('event.id', 'DESC')
      .take(limit + 1);

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
      // Phase 11 review: the same contract as InventoryService.listAll — `days=N` is N
      // calendar dates ending with today — so "Last 7 days" means one thing across the
      // API. The *function* differs because the column does: `created_at` is a real
      // instant, so its boundary is local midnight, where `occurred_at` is a date-only
      // value that has to be anchored the way it was written. See common/days-cutoff.ts
      // for the sweep showing why one formula cannot serve both.
      qb.andWhere('event.createdAt >= :cutoff', {
        cutoff: daysCutoffForInstantColumn(query.days),
      });
    }
    return trimToLimit(await qb.getMany(), limit);
  }
}
