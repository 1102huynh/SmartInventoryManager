import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
} from 'class-validator';

// BR-030/031: the client sends the new *counted* total, not a raw +/- delta — see
// docs/ui-open-questions.md Q-UI-2 for why (matches how a physical stocktake works,
// and @Min(0) here structurally rules out ever producing a negative-stock adjustment,
// satisfying BR-033/BR-041 before the service layer even runs).
// BR-032: reason is mandatory for every adjustment, free text is fine.
export class CreateAdjustmentDto {
  @IsInt()
  @Min(0)
  newQuantity: number;

  @IsDateString()
  occurredAt: string;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
