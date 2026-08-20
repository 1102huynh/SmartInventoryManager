import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

// AuthGuard('jwt') is a thin wrapper Nest/Passport provides around whatever strategy
// is registered under that name (JwtStrategy, see jwt.strategy.ts) — on its own it
// would reject every request without a valid token, with no exceptions. This
// subclass adds exactly one thing: before delegating to that default behavior, check
// whether the route (or its whole controller) was marked with @Public() — if so,
// skip the check entirely. Injecting Reflector here works even though this guard is
// registered globally (as an APP_GUARD provider in auth.module.ts) because Nest's DI
// container builds it like any other provider — see
// docs/learning-notes/authentication-and-guards.md "APP_GUARD".
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
