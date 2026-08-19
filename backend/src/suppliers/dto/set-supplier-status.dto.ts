import { IsEnum } from 'class-validator';
import { EntityStatus } from '../../common/enums/entity-status.enum';

export class SetSupplierStatusDto {
  @IsEnum(EntityStatus)
  status: EntityStatus;
}
