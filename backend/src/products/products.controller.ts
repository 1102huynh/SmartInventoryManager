import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { CreateProductDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { SetProductStatusDto } from './dto/set-product-status.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

// @Roles(UserRole.Owner) below is applied per-route, not per-controller (see
// docs/phase-5-plan.md §2 "Routes that gain @Roles(UserRole.Owner)") — this
// controller's GET routes stay open to any authenticated user; a class-level
// @Roles() would lock reads too.
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@Query() query: QueryProductsDto) {
    return this.productsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.productsService.findOne(id);
  }

  @Roles(UserRole.Owner)
  @Post()
  create(@Body() dto: CreateProductDto, @CurrentUserId() actorId: number) {
    return this.productsService.create(dto, actorId);
  }

  @Roles(UserRole.Owner)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
    @CurrentUserId() actorId: number,
  ) {
    return this.productsService.update(id, dto, actorId);
  }

  @Roles(UserRole.Owner)
  @Patch(':id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetProductStatusDto,
    @CurrentUserId() actorId: number,
  ) {
    return this.productsService.setStatus(id, dto.status, actorId);
  }

  @Roles(UserRole.Owner)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT) // a successful DELETE returns no body — 204, not 200
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUserId() actorId: number) {
    return this.productsService.remove(id, actorId);
  }
}
