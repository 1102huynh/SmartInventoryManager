import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../common/enums/user-role.enum';
import { RolesGuard } from './roles.guard';

// Mocked Reflector and ExecutionContext — the same style all-exceptions.filter.spec.ts
// uses for ArgumentsHost: build only what RolesGuard.canActivate actually calls,
// rather than spinning up a real Nest request pipeline.
describe('RolesGuard', () => {
  function makeContext(user?: { id: number; role: UserRole }): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  function makeGuard(requiredRoles: UserRole[] | undefined) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('allows the request when the route declares no @Roles() metadata', () => {
    const guard = makeGuard(undefined);
    const context = makeContext({ id: 1, role: UserRole.Staff });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows the request when the route declares an empty roles array', () => {
    const guard = makeGuard([]);
    const context = makeContext({ id: 1, role: UserRole.Staff });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("allows the request when the caller's role matches the required role", () => {
    const guard = makeGuard([UserRole.Owner]);
    const context = makeContext({ id: 1, role: UserRole.Owner });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("throws ForbiddenException when the caller's role does not match", () => {
    const guard = makeGuard([UserRole.Owner]);
    const context = makeContext({ id: 1, role: UserRole.Staff });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('denies rather than throwing a TypeError when request.user is missing', () => {
    const guard = makeGuard([UserRole.Owner]);
    const context = makeContext(undefined);
    expect(guard.canActivate(context)).toBe(false);
  });
});
