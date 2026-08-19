import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { InventoryTransaction } from './inventory-transaction.entity';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

// Product and Supplier are registered here too, even though CategoriesModule/
// ProductsModule/SuppliersModule each register their own — TypeOrmModule.forFeature
// just grants THIS module's providers a repository token for those entities; it's not
// exclusive ownership. Inventory needs Product/Supplier repositories purely to lock a
// row and read status during a write — it does not need ProductsService/
// SuppliersService and does not import those modules, which keeps the dependency
// arrow one-directional (Products → Inventory, never the reverse).
@Module({
  imports: [
    TypeOrmModule.forFeature([InventoryTransaction, Product, Supplier]),
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
