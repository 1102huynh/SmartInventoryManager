import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { RESULT_TRUNCATED_HEADER } from '../common/result-truncated.header';
import { CreateAdjustmentDto } from '../inventory/dto/create-adjustment.dto';
import { AdjustmentsService } from './adjustments.service';
import { QueryAdjustmentRequestsDto } from './dto/query-adjustment-requests.dto';
import { SetAdjustmentRequestStatusDto } from './dto/set-adjustment-request-status.dto';

// Phase 12 (docs/phase-12-plan.md §1). This controller lives in AdjustmentsModule,
// which imports InventoryModule and never the reverse — so the "InventoryModule
// depends on nothing" property (architecture-observations.md, since Phase 2) stays
// true and the seam a future extraction would use is undisturbed.
//
// No prefix on @Controller(): POST /products/:id/adjustments keeps its exact path
// (Nest routes by decorator, not by module) while the two /adjustment-requests routes
// sit alongside it. None of these carry @Roles(): submit and read are open to both
// roles (BR-072 / BR-073), and the PATCH's gate is per-row and lives in the service.
@Controller()
export class AdjustmentsController {
  constructor(private readonly adjustmentsService: AdjustmentsService) {}

  // BR-085. Owner → 201 + InventoryTransaction (byte-identical to pre-phase). Staff →
  // 202 Accepted + AdjustmentRequest: the honest code, the request was accepted and
  // has not been acted on. @Res({ passthrough: true }) lets the Staff branch set 202
  // without taking over the response, so ClassSerializerInterceptor still runs.
  @Post('products/:id/adjustments')
  async submit(
    @Param('id', ParseIntPipe) productId: number,
    @Body() dto: CreateAdjustmentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adjustmentsService.submit(productId, dto, user);
    if (result.outcome === 'requested') {
      res.status(HttpStatus.ACCEPTED);
      return result.request;
    }
    return result.transaction;
  }

  // A log by Phase 11's stronger test (the resolved set grows with the business
  // forever), so it ships bounded on day one: same { rows, truncated } shape and same
  // X-Result-Truncated header — present only when more matched — as the four reads
  // that already do this. Open to both roles (BR-073), but a Staff caller only ever
  // sees their OWN requests — the service scopes the query by `user`, not by a
  // client-supplied param, so it can't be widened by a crafted query string.
  @Get('adjustment-requests')
  async list(
    @Query() query: QueryAdjustmentRequestsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { rows, truncated } = await this.adjustmentsService.list(query, user);
    if (truncated) res.setHeader(RESULT_TRUNCATED_HEADER, 'true');
    return rows;
  }

  // The fourth status PATCH in the app, after products/suppliers/users. The honest
  // cost, recorded rather than glossed: this one has a side effect no other status
  // PATCH has — approving inserts a row into inventory_transactions — so the response
  // carries the request with its resulting_transaction relation populated, and the
  // caller does not have to guess whether one appeared.
  @Patch('adjustment-requests/:id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetAdjustmentRequestStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.adjustmentsService.resolve(id, dto, user);
  }
}
