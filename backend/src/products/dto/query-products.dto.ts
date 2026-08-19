import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

// Mirrors the UI mockup's Product List filter exactly (status=all|active|inactive|low|out)
// rather than modeling "low" and "out" as separate boolean query params — one filter
// concept, one param, same shape the frontend already sends.
export class QueryProductsDto {
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
