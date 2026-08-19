import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

// Not PartialType(CreateProductDto) here on purpose: PartialType makes every field
// *optional* (absent = "don't touch it"), but the Product Form needs to be able to
// explicitly CLEAR the threshold back to "not set" (BR-061), which means accepting a
// real `null` — a case PartialType's plain optional-ness can't express. sku is kept
// optional too; ProductsService below decides whether changing it is actually allowed
// (BR-001 — only if the product has no transaction history yet).
export class UpdateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sku?: string;

  @IsString()
  @IsNotEmpty()
  unit: string;

  @IsOptional()
  @IsInt()
  categoryId?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  lowStockThreshold?: number | null;
}
