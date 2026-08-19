import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

// Whether `quantity` is actually satisfiable against current stock (BR-021) can't be
// checked here — a DTO only validates shape, not business state. That check happens
// in InventoryService, inside the same locked transaction that reads current stock
// (see inventory.service.ts).
export class CreateStockOutDto {
  @IsInt()
  @Min(1)
  quantity: number;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
