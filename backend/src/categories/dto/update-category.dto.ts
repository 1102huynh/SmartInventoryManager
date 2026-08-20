import { PartialType } from '@nestjs/mapped-types';
import { CreateCategoryDto } from './create-category.dto';

// PartialType is fine here (unlike UpdateProductDto) — a Category has exactly one
// field, and there's no "explicitly clear it back to null" case to express; name is
// required whenever it's provided at all. Matches the pattern UpdateSupplierDto uses.
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
