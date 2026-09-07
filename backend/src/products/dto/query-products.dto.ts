import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

// Mirrors the UI mockup's Product List filter exactly (status=all|active|inactive|low|out)
// rather than modeling "low" and "out" as separate boolean query params — one filter
// concept, one param, same shape the frontend already sends.
//
// Phase 14 (docs/phase-14-plan.md §1): `extends PaginationQueryDto` adds the optional
// `page`/`pageSize`. When neither is sent, `ProductsService.findAll` returns the bare
// `ProductWithStock[]` the category screen's product-count read and the History
// screen's product filter still rely on.
export class QueryProductsDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['active', 'inactive', 'low', 'out'])
  status?: 'active' | 'inactive' | 'low' | 'out';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;
}
