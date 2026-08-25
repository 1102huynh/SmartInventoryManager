import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuditEventType } from '../../common/enums/audit-event-type.enum';

// Phase 9 (docs/phase-9-plan.md §1 "Newest first, capped, no pagination"). Mirrors
// QueryTransactionsDto deliberately — same optional-filter shape — so the two query
// endpoints read the same way. @Max(500) rather than silently clamping in the
// service: the global ValidationPipe already turns a violated constraint into the
// documented 400 shape, and a request for limit=100000 is a caller misunderstanding
// the endpoint, better answered than quietly reinterpreted into something else.
export class QueryAuditEventsDto {
  @IsOptional()
  @IsEnum(AuditEventType)
  eventType?: AuditEventType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  actorUserId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  subjectUserId?: number;

  // @Min(1): a non-positive `days` (0 or negative) has no sensible meaning as a
  // lookback window — without this floor it silently produces an empty result
  // (created_at >= a cutoff in the future) instead of the 400 a caller would expect,
  // the same reasoning `limit` already gets a floor for.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number; // default 100, applied by AuditService.findAll
}
