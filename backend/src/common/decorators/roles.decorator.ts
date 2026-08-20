import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../enums/user-role.enum';

// Same SetMetadata-based shape as public.decorator.ts. RolesGuard (registered
// globally, see auth/roles.guard.ts) reads this label back via Reflector to decide
// whether the signed-in caller's role is allowed to hit this route (or whole
// controller). No metadata at all means "any authenticated user" — see RolesGuard's
// default-open behavior.
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
