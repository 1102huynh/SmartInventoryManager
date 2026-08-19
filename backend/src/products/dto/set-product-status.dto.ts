import { IsEnum } from 'class-validator';
import { EntityStatus } from '../../common/enums/entity-status.enum';

export class SetProductStatusDto {
  @IsEnum(EntityStatus)
  status: EntityStatus;
}
