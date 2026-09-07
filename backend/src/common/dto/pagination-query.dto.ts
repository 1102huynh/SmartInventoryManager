import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_PAGE_SIZE } from '../pagination';

// Phase 14 (docs/phase-14-plan.md §1 Fork E). The optional paging parameters every
// catalogue list DTO gains — `QueryProductsDto`, `QuerySuppliersDto`,
// `QueryCategoriesDto` (new — `/categories` bound no query object before), and
// `QueryUsersDto` (new — `/users` bound none either) all `extends` this.
//
// Optional: absent means "the whole list", the shape every non-screen caller (the
// wizard pickers, the `CATEGORIES` cache) still relies on. Floor and ceiling are
// validation, not clamping — `pageSize=1000` is a `400`, the same call Phase 11 made
// for `limit`. The default page size lives in the service (common/pagination.ts), not
// here, so an omitted `pageSize` is `undefined` at this layer, not `50`.
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}
