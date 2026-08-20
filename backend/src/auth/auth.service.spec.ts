import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/user.entity';
import { AuthService } from './auth.service';

// A unit test: mocked repository, no HTTP, no database — same style as
// suppliers.service.spec.ts. bcrypt itself is NOT mocked (the hash below is a real
// bcrypt.hashSync output, computed once at module load) — the whole point of this
// service is the hash comparison, so faking bcrypt would test nothing.
describe('AuthService', () => {
  let service: AuthService;
  const repo = { findOne: jest.fn() };
  const jwtService = { sign: jest.fn(() => 'signed.jwt.token') };

  const PASSWORD = 'correct-horse-battery-staple';
  const passwordHash = bcrypt.hashSync(PASSWORD, 10);
  const user: User = {
    id: 1,
    name: 'Jordan Lee',
    role: UserRole.Staff,
    email: 'jordan@example.com',
    passwordHash,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe('validateUser', () => {
    it('returns the user when the email exists and the password matches', async () => {
      repo.findOne.mockResolvedValue(user);
      const result = await service.validateUser(user.email, PASSWORD);
      expect(result).toBe(user);
    });

    it('returns null when the password is wrong', async () => {
      repo.findOne.mockResolvedValue(user);
      const result = await service.validateUser(user.email, 'wrong-password');
      expect(result).toBeNull();
    });

    it('returns null when no user has that email, without touching bcrypt', async () => {
      repo.findOne.mockResolvedValue(null);
      const result = await service.validateUser('nobody@example.com', PASSWORD);
      expect(result).toBeNull();
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
