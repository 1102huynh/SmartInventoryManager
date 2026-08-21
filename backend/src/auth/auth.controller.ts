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
import { Public } from '../common/decorators/public.decorator';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';

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
