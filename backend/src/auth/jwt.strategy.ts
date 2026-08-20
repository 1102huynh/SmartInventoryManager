import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../config/configuration';

interface JwtPayload {
  sub: number;
}

// passport-jwt's Strategy is an adapter Nest wraps via PassportStrategy — it handles
// pulling the token out of the request and verifying its signature/expiry on its own;
// validate() below is the one piece of application code this actually needs to write.
// Whatever it returns becomes `request.user`, which is what CurrentUserId then reads.
// See docs/learning-notes/authentication-and-guards.md "Passport strategies".
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService<AppConfig, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('auth.jwtSecret', { infer: true }),
    });
  }

  // Only called once the token's signature and expiry have already checked out — a
  // request with a missing/malformed/expired/tampered token never reaches this
  // method at all; Passport rejects it with 401 before validate() runs.
  validate(payload: JwtPayload): { id: number } {
    return { id: payload.sub };
  }
}
