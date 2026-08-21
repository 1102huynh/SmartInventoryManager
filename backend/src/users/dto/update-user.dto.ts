import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateUserDto } from './create-user.dto';

// name / email / role only — password never rides along on the general update path
// (see docs/phase-6-plan.md §1 "Passwords: the Owner sets them, and there is no email
// in this system": a reset goes through PATCH /users/:id/password instead). All three
// fields are optional so an Owner correcting just one typo doesn't have to resend the
// others — matching UpdateSupplierDto's PartialType(Create...) reuse.
export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['password'] as const),
) {}
