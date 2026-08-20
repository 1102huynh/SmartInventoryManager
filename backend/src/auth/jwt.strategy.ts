import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../config/configuration';
import { UserRole } from '../common/enums/user-role.enum';
import { UsersService } from '../users/users.service';

interface JwtPayload {
  sub: number;
}

// passport-jwt's Strategy is an adapter Nest wraps via PassportStrategy — it handles
// pulling the token out of the request and verifying its signature/expiry on its own;
// validate() below is the one piece of application code this actually needs to write.
// Whatever it returns becomes `request.user`, which is what CurrentUserId and
// RolesGuard then read. See docs/learning-notes/authentication-and-guards.md
// "Passport strategies".
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('auth.jwtSecret', { infer: true }),
    });
  }

  // Only called once the token's signature and expiry have already checked out — a
  // request with a missing/malformed/expired/tampered token never reaches this
  // method at all; Passport rejects it with 401 before validate() runs.
  //
  // Phase 5 (docs/phase-5-plan.md §1 "The role is read from the database per
  // request, not carried in the JWT"): the payload only ever carries the user's id
  // (see AuthService.login's comment on why), so authorizing anything by role means
  // looking the user up here, on every authenticated request. The cost is one
  // primary-key lookup per request, which at this project's scale is not worth
  // optimizing against the correctness property it buys: a role change takes effect
  // on the user's next request rather than their next login, and a token whose user
  // no longer exists is rejected with 401 instead of sailing through on a valid
  // signature alone.
  async validate(payload: JwtPayload): Promise<{ id: number; role: UserRole }> {
    const user = await this.usersService.findOne(payload.sub).catch(() => null);
    if (!user) {
      throw new UnauthorizedException('This account no longer exists.');
    }
    return { id: user.id, role: user.role };
  }
}
