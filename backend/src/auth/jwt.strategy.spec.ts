import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { JwtStrategy } from './jwt.strategy';

// validate() is the one piece of JwtStrategy that's actually application code (the
// rest is passport-jwt verifying the token before this ever runs) — see
// docs/learning-notes/authentication-and-guards.md "Passport strategies".
//
// Phase 5 (docs/phase-5-plan.md §2 "JwtStrategy.validate gains the role lookup"):
// validate() now looks the user up by id instead of trusting the payload alone, so
// it needs a mocked UsersService and became async.
describe('JwtStrategy', () => {
  const configService = { get: () => 'test-secret' } as unknown as ConfigService;

  function makeStrategy(usersService: Partial<UsersService>) {
    return new JwtStrategy(configService as any, usersService as UsersService);
  }

  it("looks the user up by the token's subject and returns { id, role } from the database", async () => {
    const usersService = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 42, role: UserRole.Owner } as User),
    };
    const strategy = makeStrategy(usersService);

    await expect(strategy.validate({ sub: 42 })).resolves.toEqual({
      id: 42,
      role: UserRole.Owner,
    });
    expect(usersService.findOne).toHaveBeenCalledWith(42);
  });

  it('throws UnauthorizedException when the token is otherwise valid but its user no longer exists', async () => {
    const usersService = {
      findOne: jest.fn().mockRejectedValue(new Error('User 99 not found.')),
    };
    const strategy = makeStrategy(usersService);

    await expect(strategy.validate({ sub: 99 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
