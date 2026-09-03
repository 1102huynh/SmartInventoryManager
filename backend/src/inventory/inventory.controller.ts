import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { RESULT_TRUNCATED_HEADER } from '../common/result-truncated.header';
import { CreateStockInDto } from './dto/create-stock-in.dto';
import { CreateStockOutDto } from './dto/create-stock-out.dto';
import { QueryProductTransactionsDto } from './dto/query-product-transactions.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { InventoryService } from './inventory.service';

// Stock-in/out are modeled as actions under a product (POST /products/:id/stock-in),
// not as generic POST /inventory-transactions — they are meaningfully different
// operations with different validation, not one generic "create a transaction" write.
// Reads stay generic (GET /inventory-transactions), since a filtered read genuinely is
// one shape reused by three screens.
//
// Phase 12 (docs/phase-12-plan.md §1 "A new module, deliberately outside
// InventoryModule"): POST /products/:id/adjustments used to live here too. It now
// lives on AdjustmentsController — the path is unchanged (Nest routes by decorator,
// not by module), and moving the handler is what keeps the dependency arrow correct
// (AdjustmentsModule → InventoryModule, never the reverse). A reviewer scanning this
// controller for the adjustment route and not finding it should read that section.
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

  // Phase 11 (docs/phase-11-plan.md §2): both reads are bounded now. The service
  // returns { rows, truncated }; the controller sets X-Result-Truncated when there
  // was more and returns the bare array the frontend and the e2e specs already
  // destructure — @Res({ passthrough: true }) lets a header be set without taking
  // over the response, so the ClassSerializerInterceptor still runs.
  @Get('products/:id/transactions')
  async listForProduct(
    @Param('id', ParseIntPipe) productId: number,
    @Query() query: QueryProductTransactionsDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { rows, truncated } = await this.inventoryService.listForProduct(
      productId,
      query,
    );
    if (truncated) res.setHeader(RESULT_TRUNCATED_HEADER, 'true');
    return rows;
  }

  @Get('inventory-transactions')
  async listAll(
    @Query() query: QueryTransactionsDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { rows, truncated } = await this.inventoryService.listAll(query);
    if (truncated) res.setHeader(RESULT_TRUNCATED_HEADER, 'true');
    return rows;
  }
}
