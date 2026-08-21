import { IsEnum } from 'class-validator';
import { EntityStatus } from '../../common/enums/entity-status.enum';

// Mirrors SetProductStatusDto/SetSupplierStatusDto exactly — status is a lifecycle
// transition with its own dedicated route (docs/phase-6-plan.md §1 "PATCH
// /users/:id/status stays separate, mirroring products and suppliers exactly").
export class SetUserStatusDto {
  @IsEnum(EntityStatus)
  status: EntityStatus;
}
