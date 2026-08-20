import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

// validate() is the one piece of JwtStrategy that's actually application code (the
// rest is passport-jwt verifying the token before this ever runs) — see
// docs/learning-notes/authentication-and-guards.md "Passport strategies".
describe('JwtStrategy', () => {
  it('turns a decoded payload into the shape CurrentUserId expects on request.user', () => {
    const configService = {
      get: () => 'test-secret',
    } as unknown as ConfigService;
    const strategy = new JwtStrategy(configService as any);
    expect(strategy.validate({ sub: 42 })).toEqual({ id: 42 });
  });
});
