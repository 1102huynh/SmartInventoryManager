import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

// Phase 11 (docs/phase-11-plan.md §2). `GET /products/:id/transactions` took no query
// object at all before this phase — it gains `limit` alone, rather than reusing
// QueryTransactionsDto, whose `productId`/`supplierId`/`type` would be
// meaningless-or-contradictory on a route that already names its product in the path
// and would be silently accepted and ignored. `limit` itself is identical to
// QueryTransactionsDto's / QueryAuditEventsDto's — validation, not clamping, default
// applied by InventoryService.
export class QueryProductTransactionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
