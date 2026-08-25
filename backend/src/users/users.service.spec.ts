import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { BCRYPT_ROUNDS, verifyPassword } from '../common/password';
import { User } from './user.entity';
import { UsersService } from './users.service';

// A unit test: mocked repository, no HTTP, no database — same style as
// suppliers.service.spec.ts and auth.service.spec.ts. bcrypt itself is NOT mocked —
// the whole point of `create`/`setPassword`/`changeOwnPassword` is that a real
// verifiable hash comes out the other end. makeUser() needs a hash ready
// synchronously, hence hashSync rather than the shared hashPassword() — but it still
// imports BCRYPT_ROUNDS rather than hardcoding 10, so this fixture can't silently
// drift from the real cost factor.
describe('UsersService', () => {
  let service: UsersService;
  const repo = {
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve({ id: 1, ...v })),
    // Phase 8: registerFailedLogin/clearLoginFailures persist via update(), not
    // save() — deliberately, so a failed login never bumps updated_at (see
    // UsersService.persistLoginState). Mocked separately so tests can assert the
    // right ONE of the two was called for a given write.
    update: jest.fn(),
  };
  // Phase 8 (docs/phase-8-plan.md §5): registerFailedLogin reads the threshold and
  // lockout window from config — real values, not a bare `{}`, so a test that gets
  // the threshold wrong fails loudly instead of silently comparing against NaN.
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MINUTES = 15;
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'security.maxFailedLoginAttempts') return MAX_ATTEMPTS;
      if (key === 'security.lockoutMinutes') return LOCKOUT_MINUTES;
      throw new Error(`unexpected config key in test: ${key}`);
    }),
  };
  // Phase 9 (docs/phase-9-plan.md §5): mocked the same way as auth.service.spec.ts —
  // this file only needs to prove UsersService calls record() with the right
  // actor/subject/summary, not re-verify AuditService's own persistence.
  const auditService = { record: jest.fn() };
  const ACTOR_ID = 99; // the Owner performing an administrative write in these tests

  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: 1,
      name: 'Jordan Lee',
      email: 'jordan@example.com',
      role: UserRole.Staff,
      status: EntityStatus.ACTIVE,
      passwordHash: bcrypt.hashSync('old-password', BCRYPT_ROUNDS),
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      failedLoginAttempts: 0,
      lockedUntil: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: ConfigService, useValue: configService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  describe('findOne', () => {
    it('throws NotFoundException when the user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('stores a bcrypt hash, never the plaintext password', async () => {
      repo.findOne.mockResolvedValue(null); // no existing email
      const created = await service.create(
        {
          name: 'New Hire',
          email: 'new@example.com',
          role: UserRole.Staff,
          password: 'a-real-password',
        },
        ACTOR_ID,
      );
      expect(created.passwordHash).not.toBe('a-real-password');
      await expect(
        verifyPassword('a-real-password', created.passwordHash),
      ).resolves.toBe(true);
    });

    it('throws ConflictException on a duplicate email', async () => {
      repo.findOne.mockResolvedValue(makeUser());
      await expect(
        service.create(
          {
            name: 'Duplicate',
            email: 'jordan@example.com',
            role: UserRole.Staff,
            password: 'a-real-password',
          },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // Postgres `=` and UQ_users_email are both case-sensitive — without normalizing
    // on write, "Jordan@Example.com" would sail past a lookup for the stored
    // "jordan@example.com" and the 409 this DTO promises wouldn't fire.
    it('treats a duplicate email as a duplicate regardless of case, and stores it lowercased', async () => {
      repo.findOne.mockResolvedValue(makeUser({ email: 'jordan@example.com' }));
      await expect(
        service.create(
          {
            name: 'Duplicate',
            email: 'Jordan@Example.com',
            role: UserRole.Staff,
            password: 'a-real-password',
          },
          ACTOR_ID,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { email: 'jordan@example.com' },
      });

      jest.clearAllMocks();
      repo.findOne.mockResolvedValue(null);
      const created = await service.create(
        {
          name: 'New Hire',
          email: '  NewHire@Example.com  ',
          role: UserRole.Staff,
          password: 'a-real-password',
        },
        ACTOR_ID,
      );
      expect(created.email).toBe('newhire@example.com');
    });

    // Phase 9 (docs/phase-9-plan.md §2 "each write method records its event with the
    // actor it was passed").
    it('records user_created with the actor and the new user as subject', async () => {
      repo.findOne.mockResolvedValue(null);
      const created = await service.create(
        {
          name: 'New Hire',
          email: 'new@example.com',
          role: UserRole.Staff,
          password: 'a-real-password',
        },
        ACTOR_ID,
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.USER_CREATED,
          actorUserId: ACTOR_ID,
          subjectUserId: created.id,
        }),
      );
    });
  });

  describe('update', () => {
    it('throws ConflictException when the new email is already in use', async () => {
      const target = makeUser({ id: 2, email: 'target@example.com' });
      repo.findOne
        .mockResolvedValueOnce(target) // findOne(id) inside update()
        .mockResolvedValueOnce(makeUser({ id: 1 })); // assertEmailAvailable finds a clash
      await expect(
        service.update(2, { email: 'jordan@example.com' }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('catches a duplicate email on update regardless of case', async () => {
      const target = makeUser({ id: 2, email: 'target@example.com' });
      repo.findOne
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(
          makeUser({ id: 1, email: 'jordan@example.com' }),
        );
      await expect(
        service.update(2, { email: 'JORDAN@EXAMPLE.COM' }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not re-check availability when the email is unchanged apart from case', async () => {
      const target = makeUser({ id: 2, email: 'target@example.com' });
      repo.findOne.mockResolvedValueOnce(target);
      const result = await service.update(
        2,
        { email: 'Target@Example.com' },
        ACTOR_ID,
      );
      expect(result.email).toBe('target@example.com');
      expect(repo.findOne).toHaveBeenCalledTimes(1); // only the initial findOne(id) — no availability check
    });

    it('demoting the last active Owner throws ConflictException', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(0); // no other active Owner
      await expect(
        service.update(1, { role: UserRole.Staff }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('demoting an Owner succeeds while another ACTIVE Owner exists', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(1); // one other active Owner
      const result = await service.update(
        1,
        { role: UserRole.Staff },
        ACTOR_ID,
      );
      expect(result.role).toBe(UserRole.Staff);
    });

    // The case a naive count(role='owner') implementation passes the first two cases
    // and fails: the only other Owner exists but is deactivated, so they can't
    // actually log in and keep the system usable.
    it('demoting an Owner throws ConflictException when the only other Owner is INACTIVE', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      // count() is called with status: 'active' in its where clause — the mock
      // simulates the database actually applying that filter by returning 0.
      repo.count.mockImplementation(({ where }) =>
        Promise.resolve(where.status === EntityStatus.ACTIVE ? 0 : 1),
      );
      await expect(
        service.update(1, { role: UserRole.Staff }, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('promoting Staff to Owner never checks assertOwnerRemains', async () => {
      const staff = makeUser({ id: 3, role: UserRole.Staff });
      repo.findOne.mockResolvedValue(staff);
      const result = await service.update(
        3,
        { role: UserRole.Owner },
        ACTOR_ID,
      );
      expect(result.role).toBe(UserRole.Owner);
      expect(repo.count).not.toHaveBeenCalled();
    });

    // Phase 7 (docs/phase-7-plan.md §1): @UpdateDateColumn only bumps on
    // repository.save() of a loaded entity — a QueryBuilder .update() would silently
    // skip it, since that path never loads the entity. The mocked repo here only
    // exposes save (not .update()), so this is really asserting the write goes
    // through the loaded-entity mutation this test can see, not a raw builder call a
    // mock could hide. The e2e layer (users.e2e-spec.ts) proves updated_at actually
    // moves against a real database.
    it('persists a change via repository.save on the loaded entity', async () => {
      const target = makeUser({ id: 2, name: 'Old Name' });
      repo.findOne.mockResolvedValue(target);
      await service.update(2, { name: 'New Name' }, ACTOR_ID);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, name: 'New Name' }),
      );
    });

    it('records user_updated naming the actor and the edited user as subject, only when something changed', async () => {
      const target = makeUser({ id: 2, name: 'Old Name' });
      repo.findOne.mockResolvedValue(target);
      await service.update(2, { name: 'New Name' }, ACTOR_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.USER_UPDATED,
          actorUserId: ACTOR_ID,
          subjectUserId: 2,
        }),
      );
    });

    it('does not record an event for a no-op update', async () => {
      const target = makeUser({ id: 2, name: 'Same Name' });
      repo.findOne.mockResolvedValue(target);
      await service.update(2, { name: 'Same Name' }, ACTOR_ID);
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('setStatus', () => {
    it('deactivating the last active Owner throws ConflictException', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(0);
      await expect(
        service.setStatus(1, EntityStatus.INACTIVE, ACTOR_ID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('deactivating an Owner succeeds while another active Owner exists', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(1);
      const result = await service.setStatus(
        1,
        EntityStatus.INACTIVE,
        ACTOR_ID,
      );
      expect(result.status).toBe(EntityStatus.INACTIVE);
    });

    it('deactivating a Staff member never checks assertOwnerRemains', async () => {
      const staff = makeUser({ id: 2, role: UserRole.Staff });
      repo.findOne.mockResolvedValue(staff);
      await service.setStatus(2, EntityStatus.INACTIVE, ACTOR_ID);
      expect(repo.count).not.toHaveBeenCalled();
    });

    // Reactivation is the recovery path for an accidental deactivation — it must
    // never be blocked by BR-075 (reactivating an Owner only ever ADDS an active
    // Owner) and it's untested elsewhere in this file, where every Owner case above
    // deactivates.
    it('reactivating an Owner succeeds and never checks assertOwnerRemains', async () => {
      const owner = makeUser({
        id: 1,
        role: UserRole.Owner,
        status: EntityStatus.INACTIVE,
      });
      repo.findOne.mockResolvedValue(owner);
      const result = await service.setStatus(1, EntityStatus.ACTIVE, ACTOR_ID);
      expect(result.status).toBe(EntityStatus.ACTIVE);
      expect(repo.count).not.toHaveBeenCalled();
    });

    it('records user_status_changed with the actor and the affected user as subject', async () => {
      const staff = makeUser({ id: 2, role: UserRole.Staff });
      repo.findOne.mockResolvedValue(staff);
      await service.setStatus(2, EntityStatus.INACTIVE, ACTOR_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.USER_STATUS_CHANGED,
          actorUserId: ACTOR_ID,
          subjectUserId: 2,
          summary: 'Deactivated',
        }),
      );
    });
  });

  describe('changeOwnPassword', () => {
    it('rejects with 401 on a wrong current password, and leaves the stored hash unchanged', async () => {
      const user = makeUser();
      const originalHash = user.passwordHash;
      repo.findOne.mockResolvedValue(user);
      await expect(
        service.changeOwnPassword(1, 'wrong-current', 'new-password-123'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(user.passwordHash).toBe(originalHash);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('replaces the hash when the current password is correct', async () => {
      const user = makeUser();
      repo.findOne.mockResolvedValue(user);
      await service.changeOwnPassword(1, 'old-password', 'new-password-123');
      expect(repo.save).toHaveBeenCalled();
      await expect(
        verifyPassword('new-password-123', user.passwordHash),
      ).resolves.toBe(true);
    });

    // Phase 8 (docs/phase-8-plan.md §2 "changeOwnPassword — unchanged, deliberately.
    // It has no lock to clear... and adding one would imply a state that doesn't
    // exist"): unlike setPassword (an Owner's reset, which IS the unlock mechanism),
    // this path must NOT touch the lock columns.
    it('does not touch failedLoginAttempts or lockedUntil', async () => {
      const user = makeUser({
        failedLoginAttempts: 3,
        lockedUntil: new Date(Date.now() + 5 * 60_000),
      });
      const originalLockedUntil = user.lockedUntil;
      repo.findOne.mockResolvedValue(user);
      await service.changeOwnPassword(1, 'old-password', 'new-password-123');
      expect(user.failedLoginAttempts).toBe(3);
      expect(user.lockedUntil).toBe(originalLockedUntil);
    });

    // Phase 9 (docs/phase-9-plan.md §1 "one inclusion worth defending:
    // password_changed"): actor and subject are the SAME id here, deliberately — the
    // one case where they legitimately coincide.
    it('records password_changed with actor and subject both the caller', async () => {
      const user = makeUser();
      repo.findOne.mockResolvedValue(user);
      await service.changeOwnPassword(1, 'old-password', 'new-password-123');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.PASSWORD_CHANGED,
          actorUserId: 1,
          subjectUserId: 1,
        }),
      );
    });

    it('does not record anything on a wrong current password', async () => {
      const user = makeUser();
      repo.findOne.mockResolvedValue(user);
      await expect(
        service.changeOwnPassword(1, 'wrong-current', 'new-password-123'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('setPassword', () => {
    // Phase 8 (docs/phase-8-plan.md §1 "An Owner's password reset clears the lock"):
    // this IS the unlock mechanism — no separate PATCH /users/:id/unlock route exists
    // because this one already does the job.
    it('clears failedLoginAttempts and lockedUntil, in addition to replacing the hash', async () => {
      const user = makeUser({
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      });
      repo.findOne.mockResolvedValue(user);
      await service.setPassword(1, 'a-new-password', ACTOR_ID);
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
      await expect(
        verifyPassword('a-new-password', user.passwordHash),
      ).resolves.toBe(true);
    });

    it('records user_password_reset with the actor and target as subject, never anything about either password', async () => {
      const user = makeUser();
      repo.findOne.mockResolvedValue(user);
      await service.setPassword(1, 'a-new-password', ACTOR_ID);
      const call = auditService.record.mock.calls.find(
        (c) => c[0].eventType === AuditEventType.USER_PASSWORD_RESET,
      );
      expect(call[0].actorUserId).toBe(ACTOR_ID);
      expect(call[0].subjectUserId).toBe(1);
      expect(call[0].summary).not.toMatch(/a-new-password/);
    });

    it('notes the lock was cleared in the summary only when a lock actually existed', async () => {
      const lockedUser = makeUser({
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      });
      repo.findOne.mockResolvedValue(lockedUser);
      await service.setPassword(1, 'a-new-password', ACTOR_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ summary: expect.stringMatching(/lock cleared/i) }),
      );

      jest.clearAllMocks();
      const unlockedUser = makeUser({ lockedUntil: null });
      repo.findOne.mockResolvedValue(unlockedUser);
      await service.setPassword(1, 'a-new-password', ACTOR_ID);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'Password reset by an Owner' }),
      );
    });
  });

  describe('isLocked', () => {
    it('is false when lockedUntil is null', () => {
      expect(service.isLocked(makeUser({ lockedUntil: null }))).toBe(false);
    });

    it('is false when lockedUntil is in the past', () => {
      const past = new Date(Date.now() - 1000);
      expect(service.isLocked(makeUser({ lockedUntil: past }))).toBe(false);
    });

    it('is true when lockedUntil is in the future', () => {
      const future = new Date(Date.now() + 60_000);
      expect(service.isLocked(makeUser({ lockedUntil: future }))).toBe(true);
    });
  });

  describe('registerFailedLogin', () => {
    it(`sets lockedUntil on the ${MAX_ATTEMPTS}th consecutive failure, not before`, async () => {
      const user = makeUser({ failedLoginAttempts: MAX_ATTEMPTS - 2 });
      repo.findOne.mockResolvedValue(user);

      // (N-1)th failure: increments, does NOT lock yet.
      await service.registerFailedLogin(user);
      expect(user.failedLoginAttempts).toBe(MAX_ATTEMPTS - 1);
      expect(user.lockedUntil).toBeNull();

      // Nth failure: locks, roughly LOCKOUT_MINUTES out.
      await service.registerFailedLogin(user);
      expect(user.failedLoginAttempts).toBe(MAX_ATTEMPTS);
      expect(user.lockedUntil).not.toBeNull();
      const minutesOut = (user.lockedUntil!.getTime() - Date.now()) / 60_000;
      expect(minutesOut).toBeGreaterThan(LOCKOUT_MINUTES - 1);
      expect(minutesOut).toBeLessThanOrEqual(LOCKOUT_MINUTES);
    });

    // Phase 9 (docs/phase-9-plan.md §5 "account_locked is recorded exactly once, on
    // the failure that crosses the threshold — not on the (N-1)th, and NOT on a
    // subsequent failure while already locked"). This is the pin that ties §1's
    // once-per-lock semantics to Phase 8's early return: a change to either notices
    // the other.
    it(`records account_locked exactly once, on the ${MAX_ATTEMPTS}th failure — not the (N-1)th, and not again while already locked`, async () => {
      const user = makeUser({ failedLoginAttempts: MAX_ATTEMPTS - 2 });
      repo.findOne.mockResolvedValue(user);

      await service.registerFailedLogin(user, '203.0.113.7'); // (N-1)th
      expect(auditService.record).not.toHaveBeenCalled();

      await service.registerFailedLogin(user, '203.0.113.7'); // Nth: crosses the threshold
      expect(auditService.record).toHaveBeenCalledTimes(1);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.ACCOUNT_LOCKED,
          subjectUserId: user.id,
          actorIp: '203.0.113.7',
        }),
      );

      jest.clearAllMocks();
      await service.registerFailedLogin(user, '203.0.113.7'); // still locked: early return
      expect(auditService.record).not.toHaveBeenCalled();
    });

    // Phase 8 (docs/phase-8-plan.md §1 "A lock must not become a denial-of-service
    // weapon"): the property that stops a lock from being extended forever by an
    // attacker (or anyone) scripting one guess a minute against an already-locked
    // account. "Reset the timer on every failure" is the intuitive, WRONG
    // implementation this test exists to catch.
    it('leaves lockedUntil unchanged, and never persists anything, when the account is already locked', async () => {
      const originalLockedUntil = new Date(Date.now() + 5 * 60_000);
      const user = makeUser({
        failedLoginAttempts: MAX_ATTEMPTS,
        lockedUntil: originalLockedUntil,
      });
      await service.registerFailedLogin(user);
      expect(user.lockedUntil).toBe(originalLockedUntil);
      expect(user.failedLoginAttempts).toBe(MAX_ATTEMPTS); // not incremented either
      expect(repo.update).not.toHaveBeenCalled();
    });

    // The bug this test pins: `isLocked` is false for an EXPIRED lock too (that's
    // the whole point — nothing sweeps expired locks), so without an explicit reset
    // on the way back in, a stale `failedLoginAttempts` sitting AT the threshold
    // would re-lock the account on the very next stray failure, forever, at one
    // request per lockout window instead of one per minute — the same permanent-
    // outage failure mode the "already locked" guard above exists to prevent, just
    // slower. An expired lock must give the account a genuinely fresh count.
    it('resets the counter to a fresh 1 (not 6) on the first failure after a lock has expired', async () => {
      const user = makeUser({
        failedLoginAttempts: MAX_ATTEMPTS,
        lockedUntil: new Date(Date.now() - 1000), // expired one second ago
      });
      await service.registerFailedLogin(user);
      expect(user.failedLoginAttempts).toBe(1);
      expect(user.lockedUntil).toBeNull(); // one failure, nowhere near the threshold
      expect(repo.update).toHaveBeenCalledWith(user.id, {
        failedLoginAttempts: 1,
        lockedUntil: null,
        updatedAt: user.updatedAt,
      });
    });

    // A failed login must not bump the account's updated_at — it can be fired by a
    // stranger who never authenticated as anyone, and updated_at is supposed to
    // mean "this row's own fields were edited." Pinned here at the unit layer by
    // asserting the write goes through repository.update (never save) AND
    // explicitly pins updatedAt to its unchanged value (see persistLoginState's
    // comment for why that pin is necessary — repository.update() alone does NOT
    // skip the auto-bump the way it's sometimes assumed to); the e2e layer proves
    // the real column doesn't move on a real database.
    it('persists via repository.update, never repository.save, and pins updatedAt to its current value', async () => {
      const user = makeUser({ failedLoginAttempts: 0 });
      await service.registerFailedLogin(user);
      expect(repo.update).toHaveBeenCalledWith(
        user.id,
        expect.objectContaining({ updatedAt: user.updatedAt }),
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('clearLoginFailures', () => {
    it('zeroes the counter and nulls lockedUntil, via repository.update (never save — see registerFailedLogin)', async () => {
      const user = makeUser({
        failedLoginAttempts: 3,
        lockedUntil: new Date(Date.now() + 5 * 60_000),
      });
      await service.clearLoginFailures(user);
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
      expect(repo.update).toHaveBeenCalledWith(user.id, {
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: user.updatedAt,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('is a no-op (no persistence call) when there is nothing to clear', async () => {
      const user = makeUser({ failedLoginAttempts: 0, lockedUntil: null });
      await service.clearLoginFailures(user);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});
