import { SetMetadata } from '@nestjs/common';

// SetMetadata attaches arbitrary metadata to a route handler (or a whole controller
// class) without changing its behavior by itself — it's just a label. JwtAuthGuard
// (registered globally, see auth/jwt-auth.guard.ts) reads this label back via
// Reflector to decide whether to skip its own check for this one route. This is the
// general mechanism a lot of Nest's own decorators are built on — see
// docs/learning-notes/authentication-and-guards.md "Reflector + custom metadata".
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
