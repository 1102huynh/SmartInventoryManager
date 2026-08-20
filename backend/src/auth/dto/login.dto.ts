import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

// FR-060: the only two fields a login attempt needs. @IsNotEmpty on password (rather
// than relying on @IsString alone) catches an empty string, the same reasoning
// CreateSupplierDto already applies to `name`.
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
