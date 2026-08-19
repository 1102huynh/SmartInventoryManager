import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

// createParamDecorator is how you build your own @Body()/@Param()-style decorator.
// This one reads an `x-user-id` header and hands the controller a plain number —
// nothing here verifies the caller actually IS that user (there's no login step to
// verify against yet, see docs/backend-use-cases.md "Deferred: Authentication").
// Once real auth exists, this becomes the seam where it plugs in: a Guard would
// populate `request.user` from a verified session/token, and this decorator would
// read request.user.id instead of a client-supplied header.
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): number => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['x-user-id'];
    const value = Array.isArray(header) ? header[0] : header;
    const id = parseInt(value ?? '', 10);
    // Defaults to seed user 1 (Jordan Lee) so the API is easy to exercise with curl/
    // Postman without always setting the header — the real frontend always sends it.
    return Number.isInteger(id) ? id : 1;
  },
);
