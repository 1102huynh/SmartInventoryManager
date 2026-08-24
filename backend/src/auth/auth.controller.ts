import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import loadConfig from '../config/configuration';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';

// @Throttle() accepts either a plain number or a function of the request's
// ExecutionContext, evaluated by ThrottlerGuard on every request
// (@nestjs/throttler's Resolvable<T>). Used as functions here, deliberately, rather
// than reading loadConfig().security once into a module-level constant the way the
// rest of this app reads configuration (via ConfigService, resolved once at
// bootstrap): ConfigService's value is cached for the life of the app, but these two
// routes' limits need to be genuinely live for the e2e suite, which raises the login
// limit to a generous value for every file except its own dedicated throttle tests,
// which lower it mid-run, on the same running app, to actually trip it
// (see auth.e2e-spec.ts). Calling the same configuration() factory
// ConfigModule.forRoot({ load: [configuration] }) uses keeps this the one place
// these env vars are parsed, in production exactly as much as in tests — the extra
// per-request parse cost is a handful of process.env reads, not I/O.
function loginThrottleLimit(): number {
  return loadConfig().security.loginThrottleLimit;
}
function loginThrottleTtlMs(): number {
  return loadConfig().security.loginThrottleTtlSeconds * 1000;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  // The one route exempt from the global JwtAuthGuard (see jwt-auth.guard.ts) — a
  // caller obviously can't present a token before they've logged in to get one.
  // Deliberately the same 401 message for "no such email" and "wrong password" — see
  // AuthService.validateUser for why. A deactivated account (Phase 6,
  // docs/phase-6-plan.md §1) is the one case that gets a DIFFERENT 401 message —
  // AuthService.validateUser throws that one itself rather than returning null, so it
  // propagates straight past the generic branch below unchanged.
  // Phase 8 (docs/phase-8-plan.md §2): the tighter of the two limits — this is the
  // anonymous surface, the one a caller can hit without ever having a valid token.
  // Overrides the 'default' throttler's limit/ttl for this route only; every other
  // route keeps the generous global default registered in AppModule.
  @Throttle({
    default: { limit: loginThrottleLimit, ttl: loginThrottleTtlMs },
  })
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK) // a login isn't creating a resource, so 200 rather than 201
  async login(@Body() dto: LoginDto) {
    const user = await this.authService.validateUser(dto.email, dto.password);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    return this.authService.login(user);
  }

  // Lets the frontend confirm a token it already holds is still valid (and re-fetch
  // "who am I") without re-sending credentials — e.g. right after a page load, before
  // it's decided whether to show the login screen or the app shell.
  @Get('me')
  me(@CurrentUserId() userId: number) {
    return this.usersService.findOne(userId);
  }

  // Lives here, not on UsersController, deliberately (docs/phase-6-plan.md §1
  // "UsersController gets a class-level @Roles(UserRole.Owner)"): this route is about
  // the caller's own credentials, open to any authenticated user, not about
  // administering somebody else — putting it on UsersController would force that
  // controller's class-level Owner-only guard back to a per-route form and lose the
  // property it exists for. @CurrentUserId() is what "own" means here: there is no id
  // in the URL to trust or mistrust.
  // Same tight limit as login (§2): the second password-verification surface Phase 6
  // §7 named. Deliberately throttled but NOT subject to account lockout — the caller
  // already holds a valid token, so the only realistic guesser here is the account's
  // actual owner fumbling their own current password, and locking them out would
  // punish exactly the person the feature exists to protect
  // (docs/phase-8-plan.md §1 "PATCH /auth/password gets a throttle and deliberately
  // no lock"). See UsersService.changeOwnPassword for the lock-side of that decision.
  @Throttle({
    default: { limit: loginThrottleLimit, ttl: loginThrottleTtlMs },
  })
  @Patch('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUserId() userId: number,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.usersService.changeOwnPassword(
      userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }
}
