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
//
// `extra` (Phase 10, docs/phase-10-plan.md §5) is an escape hatch for
// timestamps.integration.spec.ts, which needs every connection in its pool to open
// with a deliberately different Postgres session TimeZone — `pg`'s `options:
// '-c timezone=<zone>'` startup parameter is the reliable way to do that (applied at
// connection-open time, before any query, to every pooled connection), unlike issuing
// `SET TIME ZONE` per-query, which would only affect whichever connection happened to
// service that one query. Optional and unused by every other caller, which gets
// exactly the config this function always returned.
export function createTestDataSource(options?: {
  extra?: Record<string, unknown>;
}): DataSource {
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
    ...(options?.extra ? { extra: options.extra } : {}),
  });
}
