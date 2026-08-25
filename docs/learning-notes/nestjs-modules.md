# NestJS Modules

## Concept

A **module** is a class decorated with `@Module({ imports, controllers, providers, exports })`.
It's a boundary, not a container of logic — it declares three things: what this
chunk of the app *offers* (`controllers`, and the `providers` it makes injectable),
what it *needs from elsewhere* (`imports`), and what it's willing to *share with other
modules* (`exports`). Every NestJS app is a tree of these, rooted at `AppModule`.

## Why NestJS uses it

Without modules, every controller/service in an app would need to know how to
construct every other service it depends on — Product needing Inventory would mean
Product's code manually `new`-ing up an Inventory service, its repository, its
database connection, and so on. Modules let NestJS's dependency injection container
do that wiring instead: a module says "here's what I provide," and anything that
imports the module can ask for those providers without knowing how they're built.
This is what makes a feature genuinely swappable or testable in isolation.

## How it works in this project

`backend/src/app.module.ts` is the root — it imports `ConfigModule`, `ThrottlerModule`
(Phase 8, `docs/phase-8-plan.md` — app-wide rate-limiting configuration; the *guard*
that enforces it is registered in `AuthModule`, not here, so all three global guards'
relative order lives in one place, see `docs/learning-notes/authentication-and-guards.md`),
`DatabaseModule`, `AuthModule` (Phase 3), and one module per feature (`CategoriesModule`,
`SuppliersModule`, `InventoryModule`, `ProductsModule`, `UsersModule`, `DashboardModule`).
Each feature module is small and self-contained, e.g. `backend/src/categories/categories.module.ts`:

```ts
@Module({
  imports: [TypeOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
```

The interesting dependency in this project is `ProductsModule` importing
`InventoryModule` (to compute `currentStock`) while `InventoryModule` never imports
`ProductsModule` back — it only needs a `Product` repository for validation, not
`ProductsService` itself. That one-directional arrow (Products → Inventory, never the
reverse) is a deliberate module design decision, not an accident: see
`backend/src/products/products.module.ts` and `backend/src/inventory/inventory.module.ts`.

## Example

`backend/src/dashboard/dashboard.module.ts` imports both `TypeOrmModule.forFeature([Product])`
*and* `InventoryModule`, because `DashboardService` needs a raw `Product` repository
for counts *and* `InventoryService` for stock computation — a module can depend on
more than one thing.

## Common Mistakes

- Forgetting `exports: [...]` — a provider is private to its own module by default.
  If another module imports yours but gets a "Nest can't resolve dependencies" error,
  the fix is almost always a missing export.
- Registering the same entity's `TypeOrmModule.forFeature([X])` in a module and
  assuming that "claims" the entity somehow — it doesn't. Multiple modules can (and in
  this project, do) each register the same entity to get their own repository token;
  see `InventoryModule` and `ProductsModule` both registering `Product`.
- Putting business logic directly in a module class. A module file should really only
  ever contain the `@Module({...})` decorator — logic belongs in a service.

## Key Takeaways

- A module declares imports/controllers/providers/exports; it holds no logic itself.
- `exports` controls what's actually usable by other modules — imported ≠ exported.
- Module dependency direction is a real design decision (see Products → Inventory).
- The same entity's repository can be registered in more than one module.
