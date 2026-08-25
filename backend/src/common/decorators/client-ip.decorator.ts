import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

// Phase 9 (docs/phase-9-plan.md §1, scope fork A). Sits beside
// current-user-id.decorator.ts, but unlike @CurrentUserId() this one works on a
// @Public() route (POST /auth/login) — Express populates `req.ip` before any guard
// runs, including the throttler guard that sits first (see AuthModule's comment on
// global guard order), so there is nothing to wait on here.
//
// `req.ip` is only honest without a proxy in front of this app — see the `trust
// proxy` warning in .env.example and the README. Behind an unconfigured proxy every
// row would record the proxy's own address, which is worse than recording nothing
// because it looks like data. That warning is a throttling caveat there; it is a
// correctness caveat for the audit log here.
export const ClientIp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.ip ?? null;
  },
);
