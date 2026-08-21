import { IsString, MinLength } from 'class-validator';

// PATCH /users/:id/password (docs/phase-6-plan.md §1 "PATCH /users/:id/password is a
// *reset*, not a *recovery*"): the Owner sets a new password directly — no current
// password involved, because the Owner is by definition not the account holder.
export class SetUserPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword: string;
}
