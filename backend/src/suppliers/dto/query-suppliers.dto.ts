import { IsEnum, IsOptional, IsString } from 'class-validator';
import { EntityStatus } from '../../common/enums/entity-status.enum';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

// Query DTOs validate the URL's ?search=&status=... string parameters the same way
// a body DTO validates JSON — the ValidationPipe's `transform: true` option is what
// turns these query strings into a real QuerySuppliersDto instance with these
// decorators applied, not just a loose object.
//
// Phase 14 (docs/phase-14-plan.md §1): `extends PaginationQueryDto` adds the optional
// `page`/`pageSize`. Omitted, `SuppliersService.findAll` returns the bare array the
// stock-in wizard's supplier picker still relies on.
export class QuerySuppliersDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;
}
