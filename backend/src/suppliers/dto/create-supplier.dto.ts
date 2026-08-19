import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

// FR-010: name is the only required field; contact/email/phone are all optional in
// the mockup's Supplier form. @IsNotEmpty catches both a missing field AND an
// empty/whitespace string — `@IsString()` alone would accept "".
export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}
