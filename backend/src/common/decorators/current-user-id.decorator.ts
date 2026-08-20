import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

// createParamDecorator is how you build your own @Body()/@Param()-style decorator.
// Before Phase 3 this read an `x-user-id` header and trusted it outright — nothing
// verified the caller actually WAS that user (see docs/backend-use-cases.md
// "Deferred: Authentication"). Now it reads `request.user.id` instead, where
// `request.user` was set by JwtAuthGuard's Passport strategy (see
// auth/jwt.strategy.ts) only after the request's JWT signature and expiry were
// verified. The decorator's code barely changed — what it returns went from
// "whatever the client claimed" to "who the server cryptographically verified" — see
// docs/phase-3-plan.md "CurrentUserId becomes trustworthy".
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): number => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: { id: number } }>();
    return request.user.id;
  },
);
