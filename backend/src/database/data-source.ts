import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Category } from '../categories/category.entity';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { User } from '../users/user.entity';

// This file is used ONLY by the TypeORM CLI (`npm run migration:*`), never imported
// by the running app — the app builds its own connection via TypeOrmModule.forRootAsync
// in database.module.ts, reading the same env vars through Nest's ConfigService instead
// of `dotenv/config` directly. Two ways to read the same .env because the CLI runs
// outside of Nest's dependency injection container entirely; it needs a plain
// DataSource object to hand to `migration:run` etc.
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_DATABASE ?? 'smart_inventory',
  entities: [Category, Supplier, Product, InventoryTransaction, User],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
});
