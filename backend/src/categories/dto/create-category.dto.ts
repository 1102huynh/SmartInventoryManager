import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// FR-005: a category is just a name — see category.entity.ts, "no behavior of its
// own beyond classification". MaxLength(100) matches the length precedent set by
// Product.name/Supplier.name; uniqueness itself is enforced by
// CategoriesService.assertNameAvailable, backed by the DB's own unique constraint.
export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}
