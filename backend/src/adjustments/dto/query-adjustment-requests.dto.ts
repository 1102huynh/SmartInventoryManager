import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdjustmentRequestStatus } from '../../common/enums/adjustment-request-status.enum';

// Phase 12 (docs/phase-12-plan.md §1 "The new list read is bounded on arrival, using
// Phase 11's convention unchanged"). Copied decorator for decorator from
// QueryTransactionsDto / QueryAuditEventsDto — same optional-filter shape, same
// @Min(1) floor on `days`, same @Min(1)/@Max(500) on `limit` (validation, not a
// clamp: limit=100000 is the documented 400, not a silent reinterpretation). The
// default (100) lives in AdjustmentsService, not here, for the same reason it lives in
// AuditService / InventoryService.
export class QueryAdjustmentRequestsDto {
  @IsOptional()
  @IsEnum(AdjustmentRequestStatus)
  status?: AdjustmentRequestStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  productId?: number;

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
  limit?: number; // default 100, applied by AdjustmentsService.list
}
