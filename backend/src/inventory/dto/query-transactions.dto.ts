import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional } from 'class-validator';
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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  days?: number;
}
