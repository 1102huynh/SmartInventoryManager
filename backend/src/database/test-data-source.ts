import { DataSource } from 'typeorm';
import { AuditEvent } from '../audit/audit-event.entity';
import { Category } from '../categories/category.entity';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { User } from '../users/user.entity';

// Used ONLY by integration tests (see inventory.service.integration.spec.ts) — a
// separate physical database (smart_inventory_test) so tests never touch the seeded
// dev data, and `synchronize: true` here (unlike the real app / data-source.ts) is
// fine specifically because this database's only purpose is to be created and
// dropped by test runs.
export function createTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: parseInt(process.env.DB_PORT ?? '55432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.TEST_DB_DATABASE ?? 'smart_inventory_test',
    entities: [Category, Supplier, Product, InventoryTransaction, User, AuditEvent],
    synchronize: true,
    dropSchema: true, // each test run starts from a clean schema
  });
}
