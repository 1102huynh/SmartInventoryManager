import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

// FR-001 / BR-003: name, sku, and unit are required to create a product at all.
// categoryId and lowStockThreshold are optional — see BR-061: omitting the threshold
// is meaningfully different from setting it to 0, so this stays a nullable *optional*
// number, never defaulted.
export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsString()
  @IsNotEmpty()
  unit: string;

  @IsOptional()
  @IsInt()
  categoryId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  lowStockThreshold?: number;
}
