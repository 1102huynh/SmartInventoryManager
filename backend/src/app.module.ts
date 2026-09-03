import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdjustmentsModule } from './adjustments/adjustments.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import configuration, { AppConfig } from './config/configuration';
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
    // Phase 8 (docs/phase-8-plan.md §2). ThrottlerModule is registered here — it's
    // app-wide, the same reasoning as DatabaseModule — but the GUARD that actually
    // enforces it is registered in AuthModule, beside JwtAuthGuard/RolesGuard, so all
    // three global guards' relative order lives in one array with one comment (see
    // AuthModule for why order matters). This works across modules because
    // @nestjs/throttler's ThrottlerModule is itself @Global() — importing it once here
    // makes its providers (options, storage) injectable into AppThrottlerGuard
    // wherever that guard is declared, with no second import needed.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        throttlers: [
          {
            name: 'default',
            ttl:
              config.get('security.throttleTtlSeconds', { infer: true }) * 1000,
            limit: config.get('security.throttleLimit', { infer: true }),
          },
        ],
      }),
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    CategoriesModule,
    SuppliersModule,
    InventoryModule,
    ProductsModule,
    UsersModule,
    DashboardModule,
    AdjustmentsModule,
  ],
})
export class AppModule {}
