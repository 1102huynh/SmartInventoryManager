# Database Access: Entities, Repositories, Migrations

## Concept

**TypeORM** maps TypeScript classes ("entities") to database tables via decorators.
An entity like `backend/src/products/product.entity.ts` describes columns, types,
and relations; TypeORM uses that description two ways: to generate a
**Repository** (a typed object with `find`/`save`/`delete`/query-builder methods) and
to generate **migrations** — reviewable SQL files that bring a real database's schema
in line with what the entities describe.

## Why NestJS uses it

Two reasons this project leans on it: type safety (a `Repository<Product>` only
accepts fields `Product` actually has) and a clean separation between *how* data is
stored and *how* it's used — a service calls `repository.find({ where: {...} })`
without writing SQL, and swapping the underlying database driver wouldn't change a
single line of service code.

## How it works in this project

Every entity in `backend/src/*/​*.entity.ts` is registered with
`TypeOrmModule.forFeature([Entity])` in its module, which is what makes
`@InjectRepository(Entity)` resolvable in a constructor. Schema changes never happen
automatically (`synchronize: false` — see `database/database.module.ts`); they go
through `npm run migration:generate` / `migration:run`, producing files like
`database/migrations/1787122164465-InitSchema.ts` that are plain, readable SQL a
human can review before it ever touches a real database.

## Example

`InventoryTransaction`'s schema (`backend/src/inventory/inventory-transaction.entity.ts`)
uses `@Check(...)` decorators to push three business rules down into the database
itself, as a second line of defense behind the DTO/service validation:

```ts
@Check(`"quantity_delta" <> 0`)
@Check(`type = 'stock_in' OR supplier_id IS NULL`)
@Check(`type <> 'adjustment' OR (reason IS NOT NULL AND reason <> '')`)
```

Even a bug that bypassed `InventoryService` entirely couldn't produce a row violating
these — Postgres itself refuses the insert.

## Common Mistakes

- Giving a nullable TypeScript field (`string | null`) a `@Column()` with no explicit
  `type:` — TypeORM can't infer a column type from a union, and errors with
  `Data type "Object" ... is not supported`. Every nullable column in this project's
  entities spells out `type: 'varchar'` / `'int'` explicitly for exactly this reason
  (see `supplier.entity.ts`).
- Turning on `synchronize: true` "just for now" and forgetting about it — it silently
  alters a database's schema (including dropping columns) on every boot, with no
  history and no chance to review the change. This project never enables it outside
  the dedicated test datasource (`database/test-data-source.ts`), where wiping the
  schema on every run is the entire point.
- Calling `repository.delete({})` to clear a table — TypeORM refuses an empty
  criteria object as a safety guard. The seed script
  (`database/seeds/run-seed.ts`) uses a query-builder delete with no `.where()`
  instead, which is the deliberate "yes, delete everything" escape hatch.

## Key Takeaways

- Entities describe the schema; migrations are the reviewable, reversible way schema
  changes actually reach a database.
- A Repository is a typed provider, injected like any other — see
  `dependency-injection.md`.
- Database `@Check` constraints are a legitimate second layer of enforcement, not a
  replacement for service-layer validation.
- Nullable primitive columns need an explicit `type:` — this bit every entity in this
  project the first time.
