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

## Audit timestamps: `@CreateDateColumn` / `@UpdateDateColumn`

`Product`, `Supplier`, `User`, and `Category` (as of Phase 7,
`docs/phase-7-plan.md`) all declare:

```ts
@CreateDateColumn({ name: 'created_at' })
createdAt: Date;

@UpdateDateColumn({ name: 'updated_at' })
updatedAt: Date;
```

`@CreateDateColumn` sets the value once, on insert. `@UpdateDateColumn` bumps it on
every `save()` of a managed (loaded) entity. Both are application-side — TypeORM sets
them before issuing the `INSERT`/`UPDATE` — so anything that writes a row *without*
going through the ORM (a raw `INSERT` in an e2e spec's `beforeEach`, a manual `psql`
row) would get no value from these decorators at all. That's what the migration's own
`DEFAULT now()` covers: it's a second, database-level source for the same value,
there specifically so a non-ORM insert still ends up with a sensible timestamp
instead of a `NOT NULL` violation. See `docs/domain-model.md` §8 for which tables get
which column(s) and why.

**The one trap**: a `QueryBuilder` `.update()` call skips `@UpdateDateColumn`
entirely, because it never loads the entity into memory — it issues a raw `UPDATE`
TypeORM never gets a chance to intercept. `updated_at` only stays honest as long as
every write path goes through `repository.save()` or `.preload()` on a loaded
entity, which is what `UsersService.update`/`setStatus`/`setPassword` and
`CategoriesService.update` already do. If a future write path switches to a
`QueryBuilder` update for performance, it would need to set `updated_at` explicitly,
or `updated_at` would silently stop moving.

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
