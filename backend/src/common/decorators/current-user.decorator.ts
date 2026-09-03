import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '../enums/user-role.enum';

// Phase 12 (docs/phase-12-plan.md §1 "Who may do what to a request"). The sibling of
// CurrentUserId — same `request.user` (set by JwtStrategy.validate, only after the
// token's signature and expiry checked out), but the whole `{ id, role }` rather than
// just the id. AdjustmentsController needs both: `role` decides approve/reject
// eligibility and `id` decides withdraw eligibility (the actor must be the requester),
// and that per-row legality is why the gate is in the service rather than on
// RolesGuard — see docs/learning-notes/authentication-and-guards.md.
export interface AuthenticatedUser {
  id: number;
  role: UserRole;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    return request.user;
  },
);
