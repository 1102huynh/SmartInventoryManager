# Controllers and Services

## Concept

A **controller** (`@Controller('path')`) maps HTTP routes to method calls — its
methods are decorated with `@Get()`, `@Post()`, `@Patch()`, `@Delete()`. A **service**
(`@Injectable()`) holds the actual logic. The controller's job stops at translating a
request into a method call and a return value into a response; everything else —
validation beyond shape, business rules, database access — belongs in the service.

## Why NestJS uses it

Keeping HTTP concerns and business logic in separate classes means the business logic
can be tested (and reused) without spinning up HTTP at all — see every `*.service.spec.ts`
file in this project, none of which touch a controller or a real request. It also
means a rule like "reject stock-out if quantity exceeds current stock" has exactly one
home (`InventoryService.recordStockOut`) instead of being duplicated across whatever
different controllers might trigger a stock-out.

## How it works in this project

Every feature follows the same shape: `products.controller.ts` has no logic beyond
calling `ProductsService` and returning what it gets back —

```ts
@Post()
create(@Body() dto: CreateProductDto) {
  return this.productsService.create(dto);
}
```

— while `ProductsService.create()` does the real work: checking SKU uniqueness,
defaulting optional fields, saving to the repository. The brief for this phase was
explicit about this split ("Do not implement business rules inside controllers"), and
every controller in `backend/src` was written to hold zero business logic as a result.

## Example

`InventoryController` (`backend/src/inventory/inventory.controller.ts`) is the
starkest example — three POST routes (`stock-in`, `stock-out`, `adjustments`) that
each do nothing but forward to `InventoryService`, which is where the row-locking,
current-stock computation, and every business rule from `business-rules.md` actually
live (see `docs/learning-notes/database-transactions.md`).

## Common Mistakes

- Putting a database query directly in a controller method "just this once" — it's an
  easy habit to fall into for a quick read, but it means that logic can't be unit
  tested without HTTP, and it's now living in two different places if a similar read
  exists elsewhere.
- A controller method that does its own `if (quantity > currentStock) throw ...` —
  business validation belongs in the service even when it looks trivial, because the
  service is where the *rest* of that same rule (the row lock, the actual database
  read) already has to live anyway.

## Key Takeaways

- Controller = HTTP translation only; Service = business logic.
- This split is what makes `*.service.spec.ts` unit tests possible without an HTTP
  server or a database (for the ones using a mocked repository).
- A route handler in this project is almost always one line: call the service, return
  the result.
