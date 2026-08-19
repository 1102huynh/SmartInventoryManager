import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CreateStockInDto } from './dto/create-stock-in.dto';
import { CreateStockOutDto } from './dto/create-stock-out.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { InventoryService } from './inventory.service';

// Stock-in/out/adjustment are modeled as actions under a product
// (POST /products/:id/stock-in), not as generic POST /inventory-transactions — they
// are meaningfully different operations with different validation, not one generic
// "create a transaction" write. Reads stay generic (GET /inventory-transactions),
// since a filtered read genuinely is one shape reused by three screens.
@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('products/:id/stock-in')
  recordStockIn(
    @Param('id', ParseIntPipe) productId: number,
    @Body() dto: CreateStockInDto,
    @CurrentUserId() userId: number,
  ) {
    return this.inventoryService.recordStockIn(productId, dto, userId);
  }

  @Post('products/:id/stock-out')
  recordStockOut(
    @Param('id', ParseIntPipe) productId: number,
    @Body() dto: CreateStockOutDto,
    @CurrentUserId() userId: number,
  ) {
    return this.inventoryService.recordStockOut(productId, dto, userId);
  }

  @Post('products/:id/adjustments')
  recordAdjustment(
    @Param('id', ParseIntPipe) productId: number,
    @Body() dto: CreateAdjustmentDto,
    @CurrentUserId() userId: number,
  ) {
    return this.inventoryService.recordAdjustment(productId, dto, userId);
  }

  @Get('products/:id/transactions')
  listForProduct(@Param('id', ParseIntPipe) productId: number) {
    return this.inventoryService.listForProduct(productId);
  }

  @Get('inventory-transactions')
  listAll(@Query() query: QueryTransactionsDto) {
    return this.inventoryService.listAll(query);
  }
}
