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
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { CreateUserDto } from './dto/create-user.dto';
import { SetUserPasswordDto } from './dto/set-user-password.dto';
import { SetUserStatusDto } from './dto/set-user-status.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

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
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Patch(':id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserStatusDto,
  ) {
    return this.usersService.setStatus(id, dto.status);
  }

  @Patch(':id/password')
  @HttpCode(HttpStatus.NO_CONTENT) // a reset returns no body — the new password isn't echoed back
  async setPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetUserPasswordDto,
  ) {
    await this.usersService.setPassword(id, dto.newPassword);
  }
}
