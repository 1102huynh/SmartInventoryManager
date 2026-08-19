# Dependency Injection & Providers

## Concept

A **provider** is any class NestJS's DI container knows how to construct and hand to
whatever asks for it — typically marked `@Injectable()`. **Dependency injection**
means a class declares what it needs in its *constructor* instead of creating those
things itself:

```ts
constructor(
  @InjectRepository(Supplier)
  private readonly suppliersRepository: Repository<Supplier>,
) {}
```

`SuppliersService` never writes `new Repository(...)` — it just says "give me a
`Repository<Supplier>`," and Nest's container is responsible for building one
(from `TypeOrmModule.forFeature([Supplier])`, elsewhere) and injecting it.

## Why NestJS uses it

The alternative — a class constructing its own dependencies — makes two things hard:
swapping an implementation (e.g. a real repository for a fake one in a test) and
sharing a single instance across many consumers without wiring it through every
constructor by hand. DI solves both: the container owns construction and lifetime, so
tests can override what a class receives without touching the class's code at all,
and by default every provider is a singleton shared across the app.

## How it works in this project

Almost every service in `backend/src` receives what it needs through its constructor:
`ProductsService` receives both a `Repository<Product>` and an `InventoryService`;
`InventoryService` receives a `DataSource` and a `Repository<InventoryTransaction>`.
None of these classes import each other's concrete implementations — they only
depend on the shape (interface) exposed by what's injected.

## Example

`backend/src/suppliers/suppliers.service.spec.ts` is dependency injection made
visible: the test hands `SuppliersService` a hand-written fake object in place of the
real `Repository<Supplier>`,

```ts
Test.createTestingModule({
  providers: [SuppliersService, { provide: getRepositoryToken(Supplier), useValue: repo }],
}).compile();
```

`SuppliersService`'s code is completely unaware it's talking to a fake — that's the
entire point.

## Common Mistakes

- Reaching for `new SomeService()` instead of injecting it — this silently opts out
  of DI, and now that instance isn't shared or mockable.
- Forgetting `@Injectable()` on a class you intend to inject — without it, Nest has no
  metadata to construct the class from.
- Circular dependencies between two services that both try to inject each other — a
  sign the two responsibilities should be split differently (see the
  `nestjs-modules.md` note on Products → Inventory being one-directional on purpose).

## Key Takeaways

- Providers are classes the DI container can construct; most are `@Injectable()`.
- A class asks for what it needs via its constructor — it never builds its own
  dependencies.
- This is what makes unit testing with fakes/mocks straightforward (see
  `suppliers.service.spec.ts`).
- Providers are singletons by default — one shared instance per app, not one per request.
