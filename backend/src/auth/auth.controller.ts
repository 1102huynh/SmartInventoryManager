import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
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
  // AuthService.validateUser for why.
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
}
