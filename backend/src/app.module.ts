import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CategoriesModule } from './categories/categories.module';
import configuration from './config/configuration';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { InventoryModule } from './inventory/inventory.module';
import { ProductsModule } from './products/products.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { UsersModule } from './users/users.module';

// The root module. It imports the cross-cutting pieces (config, database) directly,
// plus every feature module — each feature module owns its own controllers/providers
// and only exports what other modules are actually meant to reuse (see each module's
// `exports` array).
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // makes ConfigService injectable anywhere without re-importing ConfigModule
      load: [configuration],
    }),
    DatabaseModule,
    CategoriesModule,
    SuppliersModule,
    InventoryModule,
    ProductsModule,
    UsersModule,
    DashboardModule,
  ],
})
export class AppModule {}
