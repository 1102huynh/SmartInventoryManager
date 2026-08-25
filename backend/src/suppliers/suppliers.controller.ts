import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { QuerySuppliersDto } from './dto/query-suppliers.dto';
import { SetSupplierStatusDto } from './dto/set-supplier-status.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SuppliersService } from './suppliers.service';

// @Roles(UserRole.Owner) below is applied per-route, not per-controller — see
// products.controller.ts for the same reasoning; this controller's GET routes stay
// open to any authenticated user.
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  findAll(@Query() query: QuerySuppliersDto) {
    return this.suppliersService.findAll(query);
  }

  @Get(':id')
  // ParseIntPipe is a built-in Pipe, same family as ValidationPipe, applied to a
  // single route param instead of a whole DTO — it converts the string from the URL
  // ("7") into a number (7) and rejects the request with 400 if it isn't one, so the
  // service never has to defend against a non-numeric id.
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.suppliersService.findOne(id);
  }

  @Roles(UserRole.Owner)
  @Post()
  create(@Body() dto: CreateSupplierDto, @CurrentUserId() actorId: number) {
    return this.suppliersService.create(dto, actorId);
  }

  @Roles(UserRole.Owner)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSupplierDto,
    @CurrentUserId() actorId: number,
  ) {
    return this.suppliersService.update(id, dto, actorId);
  }

  @Roles(UserRole.Owner)
  @Patch(':id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetSupplierStatusDto,
    @CurrentUserId() actorId: number,
  ) {
    return this.suppliersService.setStatus(id, dto.status, actorId);
  }
}
