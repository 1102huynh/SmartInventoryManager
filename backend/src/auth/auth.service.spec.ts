import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { BCRYPT_ROUNDS } from '../common/password';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

// A unit test: mocked repository, no HTTP, no database — same style as
// suppliers.service.spec.ts. bcrypt itself is NOT mocked (the hash below is a real
// bcrypt.hashSync output, computed once at module load) — the whole point of this
// service is the hash comparison, so faking bcrypt would test nothing. Uses
// hashSync rather than the shared hashPassword() because this needs to be ready
// synchronously at module load, but still imports BCRYPT_ROUNDS rather than
// hardcoding 10, so this fixture can't silently drift from the real cost factor.
describe('AuthService', () => {
  let service: AuthService;
  const repo = { findOne: jest.fn() };
  const jwtService = { sign: jest.fn(() => 'signed.jwt.token') };
  // Phase 8 (docs/phase-8-plan.md §5): AuthService now delegates the lock's actual
  // logic (the threshold, the "already locked" guard, the counter) to UsersService —
  // that logic is unit-tested against a real UsersService in users.service.spec.ts.
  // Mocked here the same way the real UsersService's constructor-injected repository
  // is mocked elsewhere: this file only needs to prove AuthService calls the RIGHT
  // method at the RIGHT point in the ordering, not re-verify the counting itself.
  const usersService = {
    isLocked: jest.fn(() => false),
    registerFailedLogin: jest.fn(),
    clearLoginFailures: jest.fn(),
  };
  // Phase 9 (docs/phase-9-plan.md §5): AuditService is mocked the same way — this
  // file only needs to prove AuthService calls record() with the RIGHT actor/subject
  // at the RIGHT point, not re-verify AuditService's own persistence (audit.service.spec.ts).
  const auditService = { record: jest.fn() };

  const PASSWORD = 'correct-horse-battery-staple';
  const passwordHash = bcrypt.hashSync(PASSWORD, BCRYPT_ROUNDS);
  const user: User = {
    id: 1,
    name: 'Jordan Lee',
    role: UserRole.Staff,
    email: 'jordan@example.com',
    status: EntityStatus.ACTIVE,
    passwordHash,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    failedLoginAttempts: 0,
    lockedUntil: null,
  };
  const IP = '203.0.113.7';

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: JwtService, useValue: jwtService },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe('validateUser', () => {
    it('returns the user when the email exists and the password matches, and clears any login failures', async () => {
      repo.findOne.mockResolvedValue(user);
      const result = await service.validateUser(user.email, PASSWORD, IP);
      expect(result).toBe(user);
      expect(usersService.clearLoginFailures).toHaveBeenCalledWith(user);
    });

    // Phase 9 (docs/phase-9-plan.md §5): a successful login records login_succeeded
    // with the subject set and no actor — the caller has authenticated as this user,
    // but "actor" means "who performed this action on someone else," which doesn't
    // apply to logging in as yourself.
    it('records login_succeeded with the subject set, on success', async () => {
      repo.findOne.mockResolvedValue(user);
      await service.validateUser(user.email, PASSWORD, IP);
      expect(auditService.record).toHaveBeenCalledWith({
        eventType: AuditEventType.LOGIN_SUCCEEDED,
        subjectUserId: user.id,
        summary: 'Login succeeded',
        actorIp: IP,
      });
    });

    // Phase 8 (docs/phase-8-plan.md §1): the login lookup is normalized the same way
    // UsersService.create/update store it — a case-mismatched email must still find
    // the account, not silently miss it and fall through to the generic 401.
    it("finds the account regardless of the email's casing", async () => {
      repo.findOne.mockResolvedValue(user);
      const result = await service.validateUser(
        'Jordan@Example.com',
        PASSWORD,
        IP,
      );
      expect(result).toBe(user);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { email: 'jordan@example.com' },
      });
    });

    it('returns null when the password is wrong, and registers the failed attempt', async () => {
      repo.findOne.mockResolvedValue(user);
      const result = await service.validateUser(
        user.email,
        'wrong-password',
        IP,
      );
      expect(result).toBeNull();
      expect(usersService.registerFailedLogin).toHaveBeenCalledWith(user, IP);
      expect(usersService.clearLoginFailures).not.toHaveBeenCalled();
    });

    it('returns null when no user has that email, without touching bcrypt or UsersService', async () => {
      repo.findOne.mockResolvedValue(null);
      const result = await service.validateUser(
        'nobody@example.com',
        PASSWORD,
        IP,
      );
      expect(result).toBeNull();
      expect(usersService.registerFailedLogin).not.toHaveBeenCalled();
      expect(usersService.clearLoginFailures).not.toHaveBeenCalled();
      expect(usersService.isLocked).not.toHaveBeenCalled();
    });

    // Phase 9 (docs/phase-9-plan.md §1 "The actor is not the subject", §5): the two
    // assertions below are the sharpest pin in the phase. An unknown email has NO
    // subject (nothing in `users` to point at) — a KNOWN email with a wrong password
    // DOES have a subject, but its actor must still be null: the person who typed the
    // wrong password is precisely NOT the account holder, and recording them as the
    // actor would be a lie the whole table depends on never telling. Without this
    // pin, a plausible "simplification" that fills in actor from the matched user
    // passes every other test in this file while quietly making the actor column
    // mean two different things.
    it('an unknown email records login_failed with BOTH actor and subject null', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.validateUser('nobody@example.com', PASSWORD, IP);
      expect(auditService.record).toHaveBeenCalledWith({
        eventType: AuditEventType.LOGIN_FAILED,
        subjectUserId: null,
        summary: 'Rejected — no account with this email',
        actorIp: IP,
      });
    });

    it('a known email with a wrong password records login_failed with subject set but actor NOT present', async () => {
      repo.findOne.mockResolvedValue(user);
      await service.validateUser(user.email, 'wrong-password', IP);
      const call = auditService.record.mock.calls.find(
        (c) => c[0].eventType === AuditEventType.LOGIN_FAILED,
      );
      expect(call[0].subjectUserId).toBe(user.id);
      // toBeFalsy(), not toBeUndefined(): the pin is "this is not a real user id,"
      // not "this key is absent" — an equivalent refactor that passed
      // `actorUserId: null` explicitly would be just as correct and must not fail
      // this, the phase's most important assertion.
      expect(call[0].actorUserId).toBeFalsy();
    });

    // Phase 9 (post-review fix): record() for login_failed must be awaited BEFORE
    // registerFailedLogin — not just called, ordered — because registerFailedLogin
    // may itself record account_locked, and the two rows sort newest-first (id
    // DESC). The lock is downstream of this failure, so it must get the higher id;
    // getting this backwards makes an Owner reading the log see the lock appear to
    // precede the very attempt that caused it.
    it('records login_failed BEFORE calling registerFailedLogin, so a resulting lock always sorts above the failure that caused it', async () => {
      repo.findOne.mockResolvedValue(user);
      const order: string[] = [];
      // *Once, not a persistent mockImplementation — jest.clearAllMocks() (the
      // beforeEach above) clears call history but not implementations, so a bare
      // mockImplementation here would silently keep pushing into this closure's
      // `order` array on every later test in the file.
      auditService.record.mockImplementationOnce(() => {
        order.push('record');
        return Promise.resolve();
      });
      usersService.registerFailedLogin.mockImplementationOnce(() => {
        order.push('registerFailedLogin');
        return Promise.resolve();
      });
      await service.validateUser(user.email, 'wrong-password', IP);
      expect(order).toEqual(['record', 'registerFailedLogin']);
    });

    // Phase 6 (docs/phase-6-plan.md §5): the two inactive-account assertions together
    // pin the load-bearing ordering from AuthService.validateUser's comment — status
    // is checked strictly AFTER the password compare, never instead of it.
    it('throws with the deactivated-account message when the password is correct but the account is inactive', async () => {
      const inactiveUser = { ...user, status: EntityStatus.INACTIVE };
      repo.findOne.mockResolvedValue(inactiveUser);
      await expect(
        service.validateUser(user.email, PASSWORD, IP),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.validateUser(user.email, PASSWORD, IP),
      ).rejects.toThrow(
        'This account has been deactivated. Ask an Owner to reactivate it.',
      );
    });

    it('returns null (the generic outcome), not the deactivated message, when an inactive account is given the WRONG password', async () => {
      // This is the assertion that stops someone "simplifying" the check to the top
      // of the method and reopening the Phase 3 email-enumeration hole: reaching the
      // deactivated message must require already knowing the correct password.
      const inactiveUser = { ...user, status: EntityStatus.INACTIVE };
      repo.findOne.mockResolvedValue(inactiveUser);
      const result = await service.validateUser(
        user.email,
        'wrong-password',
        IP,
      );
      expect(result).toBeNull();
    });

    // Phase 9 (docs/phase-9-plan.md §2 "a deactivated or locked account's rejection
    // is a login_failed, not a new event type"): the credential was right, the
    // outcome was still "did not get in."
    it('a deactivated account rejection records login_failed, not a new event type', async () => {
      const inactiveUser = { ...user, status: EntityStatus.INACTIVE };
      repo.findOne.mockResolvedValue(inactiveUser);
      await expect(
        service.validateUser(user.email, PASSWORD, IP),
      ).rejects.toThrow();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: AuditEventType.LOGIN_FAILED }),
      );
    });

    // Phase 8 (docs/phase-8-plan.md §1 "The lock message stays generic unless the
    // password was correct" / §5): the direct analogue of the deactivated-account
    // pair above, applied to the second state this function now guards.
    describe('a locked account', () => {
      const lockedUser = {
        ...user,
        // Just under 12 minutes out, so Math.ceil rounds up to exactly 12 — a value
        // right at a minute boundary would make this assertion flaky.
        lockedUntil: new Date(Date.now() + 12 * 60_000 - 1000),
      };

      it('with the correct password: throws the lock message, and does NOT clear login failures', async () => {
        repo.findOne.mockResolvedValue(lockedUser);
        usersService.isLocked.mockReturnValueOnce(true);
        await expect(
          service.validateUser(user.email, PASSWORD, IP),
        ).rejects.toThrow(
          /Too many failed attempts\. Try again in 12 minutes\./,
        );
        expect(usersService.clearLoginFailures).not.toHaveBeenCalled();
      });

      // The ordering pin: reaching the specific lock message must require already
      // knowing the correct password — the exact same enumeration-safety property
      // Phase 6's deactivated-message test pins above. Without this, a future
      // refactor that checks isLocked before verifyPassword passes every other test
      // in this file while quietly telling an unauthenticated caller which accounts
      // are currently locked.
      it('with a WRONG password: returns the generic null, never reaching the lock message', async () => {
        repo.findOne.mockResolvedValue(lockedUser);
        usersService.isLocked.mockReturnValueOnce(true);
        const result = await service.validateUser(
          user.email,
          'wrong-password',
          IP,
        );
        expect(result).toBeNull();
        expect(usersService.registerFailedLogin).toHaveBeenCalledWith(
          lockedUser,
          IP,
        );
      });

      it('deactivated AND locked: the deactivated message wins, and the lock is never even consulted', async () => {
        const inactiveAndLocked = {
          ...lockedUser,
          status: EntityStatus.INACTIVE,
        };
        repo.findOne.mockResolvedValue(inactiveAndLocked);
        await expect(
          service.validateUser(user.email, PASSWORD, IP),
        ).rejects.toThrow(
          'This account has been deactivated. Ask an Owner to reactivate it.',
        );
        expect(usersService.isLocked).not.toHaveBeenCalled();
      });

      // Phase 9 (docs/phase-9-plan.md §2 "A failed attempt against an already-locked
      // account still writes a login_failed row — that row is precisely the evidence
      // an Owner needs (someone is still hammering)"), even though
      // registerFailedLogin itself returns early and changes nothing.
      it('a WRONG password against an already-locked account still records login_failed', async () => {
        repo.findOne.mockResolvedValue(lockedUser);
        usersService.isLocked.mockReturnValueOnce(true);
        await service.validateUser(user.email, 'wrong-password', IP);
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: AuditEventType.LOGIN_FAILED,
            subjectUserId: lockedUser.id,
          }),
        );
      });
    });
  });

  describe('login', () => {
    it('signs a token carrying only the user id, and returns the user summary', () => {
      const result = service.login(user);
      expect(jwtService.sign).toHaveBeenCalledWith({ sub: user.id });
      expect(result).toEqual({
        accessToken: 'signed.jwt.token',
        user: { id: user.id, name: user.name, role: user.role },
      });
    });
  });
});
