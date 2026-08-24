import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
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
  };

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
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repo },
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
      const created = await service.create({
        name: 'New Hire',
        email: 'new@example.com',
        role: UserRole.Staff,
        password: 'a-real-password',
      });
      expect(created.passwordHash).not.toBe('a-real-password');
      await expect(
        verifyPassword('a-real-password', created.passwordHash),
      ).resolves.toBe(true);
    });

    it('throws ConflictException on a duplicate email', async () => {
      repo.findOne.mockResolvedValue(makeUser());
      await expect(
        service.create({
          name: 'Duplicate',
          email: 'jordan@example.com',
          role: UserRole.Staff,
          password: 'a-real-password',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // Postgres `=` and UQ_users_email are both case-sensitive — without normalizing
    // on write, "Jordan@Example.com" would sail past a lookup for the stored
    // "jordan@example.com" and the 409 this DTO promises wouldn't fire.
    it('treats a duplicate email as a duplicate regardless of case, and stores it lowercased', async () => {
      repo.findOne.mockResolvedValue(makeUser({ email: 'jordan@example.com' }));
      await expect(
        service.create({
          name: 'Duplicate',
          email: 'Jordan@Example.com',
          role: UserRole.Staff,
          password: 'a-real-password',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { email: 'jordan@example.com' },
      });

      jest.clearAllMocks();
      repo.findOne.mockResolvedValue(null);
      const created = await service.create({
        name: 'New Hire',
        email: '  NewHire@Example.com  ',
        role: UserRole.Staff,
        password: 'a-real-password',
      });
      expect(created.email).toBe('newhire@example.com');
    });
  });

  describe('update', () => {
    it('throws ConflictException when the new email is already in use', async () => {
      const target = makeUser({ id: 2, email: 'target@example.com' });
      repo.findOne
        .mockResolvedValueOnce(target) // findOne(id) inside update()
        .mockResolvedValueOnce(makeUser({ id: 1 })); // assertEmailAvailable finds a clash
      await expect(
        service.update(2, { email: 'jordan@example.com' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('catches a duplicate email on update regardless of case', async () => {
      const target = makeUser({ id: 2, email: 'target@example.com' });
      repo.findOne
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(makeUser({ id: 1, email: 'jordan@example.com' }));
      await expect(
        service.update(2, { email: 'JORDAN@EXAMPLE.COM' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not re-check availability when the email is unchanged apart from case', async () => {
      const target = makeUser({ id: 2, email: 'target@example.com' });
      repo.findOne.mockResolvedValueOnce(target);
      const result = await service.update(2, { email: 'Target@Example.com' });
      expect(result.email).toBe('target@example.com');
      expect(repo.findOne).toHaveBeenCalledTimes(1); // only the initial findOne(id) — no availability check
    });

    it('demoting the last active Owner throws ConflictException', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(0); // no other active Owner
      await expect(
        service.update(1, { role: UserRole.Staff }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('demoting an Owner succeeds while another ACTIVE Owner exists', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(1); // one other active Owner
      const result = await service.update(1, { role: UserRole.Staff });
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
        service.update(1, { role: UserRole.Staff }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('promoting Staff to Owner never checks assertOwnerRemains', async () => {
      const staff = makeUser({ id: 3, role: UserRole.Staff });
      repo.findOne.mockResolvedValue(staff);
      const result = await service.update(3, { role: UserRole.Owner });
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
      await service.update(2, { name: 'New Name' });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 2, name: 'New Name' }),
      );
    });
  });

  describe('setStatus', () => {
    it('deactivating the last active Owner throws ConflictException', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(0);
      await expect(
        service.setStatus(1, EntityStatus.INACTIVE),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('deactivating an Owner succeeds while another active Owner exists', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner });
      repo.findOne.mockResolvedValue(owner);
      repo.count.mockResolvedValue(1);
      const result = await service.setStatus(1, EntityStatus.INACTIVE);
      expect(result.status).toBe(EntityStatus.INACTIVE);
    });

    it('deactivating a Staff member never checks assertOwnerRemains', async () => {
      const staff = makeUser({ id: 2, role: UserRole.Staff });
      repo.findOne.mockResolvedValue(staff);
      await service.setStatus(2, EntityStatus.INACTIVE);
      expect(repo.count).not.toHaveBeenCalled();
    });

    // Reactivation is the recovery path for an accidental deactivation — it must
    // never be blocked by BR-075 (reactivating an Owner only ever ADDS an active
    // Owner) and it's untested elsewhere in this file, where every Owner case above
    // deactivates.
    it('reactivating an Owner succeeds and never checks assertOwnerRemains', async () => {
      const owner = makeUser({ id: 1, role: UserRole.Owner, status: EntityStatus.INACTIVE });
      repo.findOne.mockResolvedValue(owner);
      const result = await service.setStatus(1, EntityStatus.ACTIVE);
      expect(result.status).toBe(EntityStatus.ACTIVE);
      expect(repo.count).not.toHaveBeenCalled();
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
  });
});
