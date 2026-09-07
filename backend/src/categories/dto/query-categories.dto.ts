import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

// Phase 14 (docs/phase-14-plan.md §1/§2). New this phase — `CategoriesController.findAll`
// bound no query object before. It carries only the optional `page`/`pageSize` from
// `PaginationQueryDto`: the Categories admin screen sends them; `Store.loadReferenceData`
// (the post-login `CATEGORIES` cache) sends neither and still gets every row.
export class QueryCategoriesDto extends PaginationQueryDto {}
