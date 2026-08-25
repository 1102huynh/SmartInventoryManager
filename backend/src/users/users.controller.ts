import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { CreateUserDto } from './dto/create-user.dto';
import { SetUserPasswordDto } from './dto/set-user-password.dto';
import { SetUserStatusDto } from './dto/set-user-status.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';
import { UsersService } from './users.service';

// Phase 8 (docs/phase-8-plan.md §3): the read shape for the two GET routes only.
// failedLoginAttempts/lockedUntil stay @Exclude()d on User itself (§2 — operational
// security state, not safe on the nested `recordedBy` a transaction read embeds), so
// an Owner needing to know "is this account locked right now" is served an explicit
// computed boolean instead of the raw column. A boolean, not the timestamp: the
// remedy (reset the password, or wait) doesn't depend on the exact minute it clears.
// An explicit allow-list of fields, not `{ ...user, locked }` — spreading a class
// instance into a plain object produces a value whose constructor is Object, which
// would silently defeat ClassSerializerInterceptor's @Exclude() (it keys off the
// object's own constructor), passwordHash included. Listing exactly what goes out
// keeps the exclusion explicit regardless of the interceptor, and stays safe by
// construction if another sensitive column is ever added to User.
//
// `locked` is computed via UsersService.isLocked(user), not reimplemented inline —
// that method's own comment already claims to be "the one place that interprets the
// column," and a second inline copy here would be exactly the kind of drift the
// BR-075 `assertOwnerRemains` precedent exists to prevent: one rule, one place,
// every caller goes through it.
function withLockStatus(usersService: UsersService, user: User) {
  const { id, name, email, role, status, createdAt, updatedAt } = user;
  return {
    id,
    name,
    email,
    role,
    status,
    createdAt,
    updatedAt,
    locked: usersService.isLocked(user),
  };
}

// @Roles(UserRole.Owner) applied at the CLASS level — the first controller in the app
// to do this (docs/phase-6-plan.md §1 "UsersController gets a class-level
// @Roles(UserRole.Owner)"). ProductsController/SuppliersController apply it per-route
// because their GET routes stay open to Staff; every route here, including GET, is
// Owner-only (BR-074, amending BR-073) — see §1 for why the user list is a different
// kind of read than inventory data. RolesGuard's
// getAllAndOverride(ROLES_KEY, [getHandler(), getClass()]) already reads class-level
// metadata, so no guard change was needed for this.
@Roles(UserRole.Owner)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll() {
    const users = await this.usersService.findAll();
    return users.map((u) => withLockStatus(this.usersService, u));
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const user = await this.usersService.findOne(id);
    return withLockStatus(this.usersService, user);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUserId() actorId: number) {
    return this.usersService.create(dto, actorId);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUserId() actorId: number,
  ) {
    return this.usersService.update(id, dto, actorId);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserStatusDto,
    @CurrentUserId() actorId: number,
  ) {
    return this.usersService.setStatus(id, dto.status, actorId);
  }

  @Patch(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT) // a reset returns no body — the new password isn't echoed back
  async setPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserPasswordDto,
    @CurrentUserId() actorId: number,
  ) {
    await this.usersService.setPassword(id, dto.newPassword, actorId);
  }
}
