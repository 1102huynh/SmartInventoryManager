import { IsString, MinLength } from 'class-validator';

// PATCH /auth/password (docs/phase-6-plan.md §1 "Passwords: the Owner sets them, and
// there is no email in this system"): requires the current password even though the
// caller is already authenticated — a valid token proves who opened the tab, not who
// is sitting at it now.
export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
