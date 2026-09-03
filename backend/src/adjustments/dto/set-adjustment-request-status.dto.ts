import { IsIn, IsOptional, IsString } from 'class-validator';
import { AdjustmentRequestStatus } from '../../common/enums/adjustment-request-status.enum';

// Phase 12 (docs/phase-12-plan.md §1 "Fork B — one status route"). The fourth
// Set…StatusDto in the app, after products/suppliers/users — "change the lifecycle
// state of a thing" is spelled as a status PATCH with a { status } body three times
// already, and a fourth spelling of one idea is the drift Phase 11 refused.
//
// `pending` is deliberately absent from the allowed set: a request cannot be moved
// back to pending — there is no un-reject and no re-open (BR-087). `reason` is
// optional here and its per-status requirement (mandatory for `rejected` and
// `withdrawn`, optional for `approved`) is checked in AdjustmentsService.resolve,
// where the target status is known — a DTO cannot express "required only when another
// field has one of two values".
const RESOLVABLE_STATUSES = [
  AdjustmentRequestStatus.APPROVED,
  AdjustmentRequestStatus.REJECTED,
  AdjustmentRequestStatus.WITHDRAWN,
] as const;

export class SetAdjustmentRequestStatusDto {
  @IsIn(RESOLVABLE_STATUSES)
  status: (typeof RESOLVABLE_STATUSES)[number];

  @IsOptional()
  @IsString()
  reason?: string;
}
