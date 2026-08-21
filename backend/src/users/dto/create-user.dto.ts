import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { UserRole } from '../../common/enums/user-role.enum';

// FR-063 (docs/phase-6-plan.md §1 "Passwords: the Owner sets them"): the Owner types
// the initial password directly rather than the system generating one — see the
// plan's reasoning for why a generated-credential flow buys nothing here.
// @MinLength(8) is the whole password policy (a floor, not a policy) — no complexity
// rules, no breach-list checks; the seeded dev password 'password123' (11 chars)
// still passes.
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @MinLength(8)
  password: string;
}
