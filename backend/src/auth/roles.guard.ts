import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

// Registered globally in auth.module.ts, as a second APP_GUARD, AFTER JwtAuthGuard —
// that ordering is load-bearing, not cosmetic. Nest runs global guards in the order
// their APP_GUARD providers are registered, and this guard reads `request.user.role`,
// which only exists once JwtAuthGuard's Passport strategy has already populated it
// (see jwt.strategy.ts). Registered the other way round, this would run first, see no
// `request.user` on every request, and deny everything. See
// docs/learning-notes/authentication-and-guards.md "APP_GUARD".
//
// Default-open, mirroring @Public(): a route with no @Roles() metadata is allowed for
// any authenticated user, exactly as a route with no @Public() metadata requires a
// token. The alternative (default-closed, every route must declare a role) would mean
// touching every controller in the app just to say "no change," and a newly added
// route would fail closed with a confusing 403 instead of behaving like its
// neighbours.
@Injectable()
export class RolesGuard {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{
      user?: { id: number; role: UserRole };
    }>();
    // Belt-and-braces: JwtAuthGuard already ran and would have rejected the request
    // with 401 before this guard is ever reached, so `user` should always be set here.
    if (!user) return false;

    if (required.includes(user.role)) return true;

    // An explicit ForbiddenException rather than returning `false` is worth the extra
    // line: Nest's default for `false` is a generic "Forbidden resource," and a
    // signed-in Staff user who clicks something they shouldn't see deserves a message
    // that says why. AllExceptionsFilter passes HttpExceptions through unchanged, so
    // this arrives at the client as a clean 403 with this message.
    throw new ForbiddenException('This action requires the Owner role.');
  }
}
