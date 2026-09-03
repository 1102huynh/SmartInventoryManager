import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryModule } from '../inventory/inventory.module';
import { Product } from '../products/product.entity';
import { AdjustmentRequest } from './adjustment-request.entity';
import { AdjustmentsController } from './adjustments.controller';
import { AdjustmentsService } from './adjustments.service';

// Phase 12 (docs/phase-12-plan.md §1 "A new module, deliberately outside
// InventoryModule"). Imports InventoryModule to call one new public method on
// InventoryService (applyApprovedAdjustment) plus recordAdjustment; the arrow points
// the same direction ProductsModule and DashboardModule already point, so
// InventoryModule still depends on nothing. Registers Product here purely to check a
// product exists on submission — forFeature grants a repository token, not ownership
// (the same note InventoryModule makes about Product/Supplier).
@Module({
  imports: [
    TypeOrmModule.forFeature([AdjustmentRequest, Product]),
    InventoryModule,
  ],
  controllers: [AdjustmentsController],
  providers: [AdjustmentsService],
  exports: [AdjustmentsService],
})
export class AdjustmentsModule {}
