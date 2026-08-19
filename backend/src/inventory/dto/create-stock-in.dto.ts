import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';

// BR-012: quantity must be a positive whole number — @Min(1) on an @IsInt() rejects
// both 0 and negatives in one line. BR-011/Q-2: supplierId is optional (Phase 0 open
// question, resolved during the UI mockup phase).
export class CreateStockInDto {
  @IsInt()
  @Min(1)
  quantity: number;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsInt()
  supplierId?: number;
}
