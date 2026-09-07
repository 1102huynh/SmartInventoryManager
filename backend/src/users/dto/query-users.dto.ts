import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

// Phase 14 (docs/phase-14-plan.md §1/§2). New this phase — `UsersController.findAll`
// bound no query object before. `/users` is the one catalogue route with no second
// consumer that needs the whole set (Fork D), so a reviewer who prefers the stronger
// "this route cannot return an unbounded result" statement could make paging
// mandatory here; it is left optional to keep all four routes identical in shape.
export class QueryUsersDto extends PaginationQueryDto {}
