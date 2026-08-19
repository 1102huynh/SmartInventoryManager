import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from '../categories/category.entity';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { User } from '../users/user.entity';

// TypeOrmModule.forRootAsync, not forRoot: forRoot would need the connection options
// available synchronously at import time, but we want them to come from ConfigService
// (which itself depends on .env having been parsed). forRootAsync lets us declare
// "here's what I need (ConfigService) and here's a factory function that builds the
// real options once that's available" — this inject/useFactory pattern shows up
// constantly in NestJS for anything that needs async or config-dependent setup.
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.database'),
        entities: [Category, Supplier, Product, InventoryTransaction, User],
        // synchronize is intentionally off — see the note in data-source.ts.
        // Schema changes only happen through reviewed migrations.
        synchronize: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
