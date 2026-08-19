# DTOs and the Validation Pipe

## Concept

A **DTO** (Data Transfer Object) is a plain class describing the shape of data
crossing a boundary — in this project, always an incoming HTTP request body or query
string. Decorating its properties with `class-validator` decorators
(`@IsString()`, `@IsInt()`, `@IsOptional()`, …) turns that class into something a
**Validation Pipe** can check automatically. A Pipe runs *before* a controller
method executes and can transform or reject the incoming data.

## Why NestJS uses it

Without this, every controller method would start with manual checks —
`if (typeof body.quantity !== 'number') throw ...` repeated per field, per endpoint.
DTOs move that to declarations instead of imperative code, and registering
`ValidationPipe` once globally (`main.ts`) means *every* route gets this for free,
with no way to accidentally add a new endpoint that forgets to validate its input.

## How it works in this project

`main.ts` registers the pipe once for the whole app:

```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,          // strip properties not declared on the DTO
  forbidNonWhitelisted: true, // ...and reject the request if it sent one
  transform: true,          // turn plain JSON/query strings into real DTO instances
}));
```

Every `dto/*.ts` file in `backend/src/*/dto/` is one of these classes. The most
business-rule-driven one is `backend/src/inventory/dto/create-adjustment.dto.ts`:

```ts
export class CreateAdjustmentDto {
  @IsInt() @Min(0)
  newQuantity: number; // structurally can't be negative — BR-033/041 partly enforced here
  @IsString() @IsNotEmpty()
  reason: string; // BR-032: mandatory
}
```

## Example

Try `POST /products` with `{ "name": "" }` (see `test/app.e2e-spec.ts`,
"rejects an invalid product payload") — the response is `400` with
`message: ["name should not be empty", ...]`, generated entirely from
`CreateProductDto`'s decorators, with no code in `ProductsController` or
`ProductsService` involved in producing that error.

## Common Mistakes

- Confusing a DTO's validation with business-rule validation. A DTO can guarantee
  "quantity is a positive integer"; it cannot know whether that quantity is
  *available* — that requires reading the database, which only the service can do
  (see `InventoryService.recordStockOut`).
- Reusing an entity class as a request DTO. An entity has fields like `id` and
  `createdAt` a client should never be able to set — a separate DTO class is what
  makes `whitelist: true` able to strip those out.
- Forgetting `@IsOptional()` on a field that's genuinely optional — without it, a
  request that omits the field fails validation even though the field was never
  required.

## Key Takeaways

- A DTO declares shape; class-validator decorators declare the rules.
- `ValidationPipe` runs once, globally, before any controller code executes.
- `whitelist` + `forbidNonWhitelisted` reject unexpected fields instead of silently
  dropping them — better feedback for whoever's calling the API.
- DTO validation and service-layer business-rule validation are two different layers
  that both matter — see `docs/learning-notes/database-transactions.md` for where the
  second one lives.
