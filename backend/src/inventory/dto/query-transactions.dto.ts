import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TransactionType } from '../../common/enums/transaction-type.enum';

// Backs both the global Inventory History screen (FR-031, no filters set) and the
// Supplier Detail "stock received from this supplier" panel (FR-012, supplierId set)
// — one query endpoint, reused, rather than a near-duplicate one per screen.
export class QueryTransactionsDto {
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  productId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  supplierId?: number;

  // @Min(1): matches QueryAuditEventsDto's floor, which this DTO did not have.
  // Without it, `?days=0` silently produces an empty result (occurredAt >= a cutoff
  // in the future) instead of the 400 a caller would expect — the same reasoning
  // `limit` gets a floor for, and leaving two spellings of one rule in the codebase
  // is worse than the one line it costs (docs/phase-11-plan.md §2).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;

  // Phase 11 (docs/phase-11-plan.md §1). Deliberately identical to
  // QueryAuditEventsDto's limit, down to the decorators: the floor and the ceiling
  // are validation, not clamping, so limit=100000 is the documented 400 rather than
  // a silent reinterpretation (Phase 9's reasoning, unchanged). The default (100)
  // lives in InventoryService, not here, for the same reason it lives in
  // AuditService.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
