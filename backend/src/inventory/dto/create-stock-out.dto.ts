import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import { StockOutReason } from '../../common/enums/stock-out-reason.enum';

// Whether `quantity` is actually satisfiable against current stock (BR-021) can't be
// checked here — a DTO only validates shape, not business state. That check happens
// in InventoryService, inside the same locked transaction that reads current stock
// (see inventory.service.ts).
//
// Phase 18 (docs/phase-18-plan.md, product.md Q-4): `reasonCategory` is an optional
// structured "why did this stock leave" from a fixed set (FR-021 is unchanged — the
// reason has always been optional; FR-025 adds the picker). `reason` is the free-text
// counterpart, and BR-023 makes it mandatory when the category is `other` — an
// unexplained "Other" carries no information.
export class CreateStockOutDto {
  @IsInt()
  @Min(1)
  quantity: number;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsEnum(StockOutReason)
  reasonCategory?: StockOutReason;

  // Optional in general, but required (and non-empty) when the category is `other`, or
  // whenever a value is supplied at all — an empty-string reason is not a note.
  @ValidateIf(
    (o: CreateStockOutDto) =>
      o.reasonCategory === StockOutReason.OTHER || o.reason !== undefined,
  )
  @IsString()
  @IsNotEmpty({
    message:
      'A note is required when the stock-out reason category is "Other".',
  })
  reason?: string;
}
