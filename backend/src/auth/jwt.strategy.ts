import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../config/configuration';
import { EntityStatus } from '../common/enums/entity-status.enum';
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
    // Only a genuine "no such user" (UsersService.findOne's NotFoundException) means
    // the token is stale — that's the one case that should become a 401. Anything
    // else (a DB connection blip, a timeout) must NOT be swallowed into the same
    // "account no longer exists" response: this runs on every authenticated request,
    // so treating a transient failure as a deleted account would log every signed-in
    // user out and tell them their account was deleted, and re-throwing lets
    // AllExceptionsFilter log the real error server-side instead of losing it here.
    const user = await this.usersService.findOne(payload.sub).catch((err) => {
      if (err instanceof NotFoundException) return null;
      throw err;
    });
    if (!user) {
      throw new UnauthorizedException('This account no longer exists.');
    }
    // Phase 6 (docs/phase-6-plan.md §1 "Deactivation is what token revocation turned
    // out to be"): this lookup already runs on every authenticated request for the
    // role-freshness reason above — adding a status check here costs nothing extra
    // and is the one piece that makes deactivation take effect on the user's very
    // next request instead of at their token's expiry up to 12 hours later. Same
    // exception shape as the deleted-user case just above: from the caller's point of
    // view "this token no longer identifies someone who may be here" is one category,
    // whether the row is gone or merely deactivated.
    if (user.status === EntityStatus.INACTIVE) {
      throw new UnauthorizedException('This account has been deactivated.');
    }
    return { id: user.id, role: user.role };
  }
}
