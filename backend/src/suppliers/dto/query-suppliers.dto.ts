import { IsEnum, IsOptional, IsString } from 'class-validator';
import { EntityStatus } from '../../common/enums/entity-status.enum';

// Query DTOs validate the URL's ?search=&status=... string parameters the same way
// a body DTO validates JSON — the ValidationPipe's `transform: true` option is what
// turns these query strings into a real QuerySuppliersDto instance with these
// decorators applied, not just a loose object.
export class QuerySuppliersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;
}
