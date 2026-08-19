# Phase 2 — NestJS Implementation Review

Status: Phase 2 — NestJS Backend, review pass
Last updated: 2026-08-19

This document does not introduce new concepts — it consolidates the individual notes
in this folder into one practical walkthrough of how they work together in **this**
project's actual code under `backend/src/`. Read the individual notes
([nestjs-modules.md](nestjs-modules.md), [dependency-injection.md](dependency-injection.md),
[controllers-and-services.md](controllers-and-services.md),
[dto-and-validation.md](dto-and-validation.md), [database-access.md](database-access.md),
[database-transactions.md](database-transactions.md),
[exception-handling.md](exception-handling.md), [configuration.md](configuration.md),
[testing-strategy.md](testing-strategy.md)) for the concept-by-concept "what/why";
this one is the "how it all fits together, in this codebase, right now."

---

## 1. Overall Architecture

```
Frontend (frontend/index.html)
   ↓  fetch() over HTTP
NestJS  (backend/src/)
   ↓  TypeORM Repository / DataSource
PostgreSQL  (tools/ — portable local instance)
```

- **Frontend** — a single static page, no build step. Its `Store` object (see
  `frontend/index.html:341` onward) is the only part of the frontend that knows HTTP
  exists; every view calls `Store.*` methods and gets back plain JS objects/Promises.
- **NestJS** — the API. Its job is to accept HTTP, validate it, enforce every business
  rule from `docs/business-rules.md`, and be the single source of truth for what's
  allowed to happen to the data. Nothing in this project trusts the frontend to have
  validated or computed anything (see §4 for exactly how it's structured to guarantee
  that).
- **PostgreSQL** — durable storage, plus a second, independent layer of enforcement
  via schema constraints (`@Check` decorators, foreign keys) that hold even if a bug
  in the NestJS layer didn't.

The responsibility split matters: the frontend never computes `currentStock`,
`lowStock`, or whether a SKU is taken — those all come back from NestJS already
computed (see `ProductsService.attachStock`, `products.service.ts:144-159`). This
isn't a style preference; it's what makes the API the actual source of truth instead
of a thin pass-through the frontend could get out of sync with.

---

## 2. NestJS Application Structure

| Piece | File(s) | Role |
|---|---|---|
| `main.ts` | `backend/src/main.ts` | Bootstraps the app: creates it, turns on CORS, registers the global `ValidationPipe` and `AllExceptionsFilter`, starts listening |
| `AppModule` | `backend/src/app.module.ts` | The root of the module tree — imports `ConfigModule`, `DatabaseModule`, and all six feature modules |
| Feature Modules | `categories/categories.module.ts`, `suppliers/suppliers.module.ts`, `products/products.module.ts`, `inventory/inventory.module.ts`, `users/users.module.ts`, `dashboard/dashboard.module.ts` | Each declares its own controller(s), service(s), and which entities it needs a repository for |
| Controllers | `*.controller.ts` in each feature folder | HTTP-facing — route → method → call one service method |
| Services | `*.service.ts` in each feature folder | Business logic and orchestration |
| Providers | Services, repositories, `InventoryService`, `ConfigService`, etc. | Anything the DI container can construct and inject |
| Repositories | `Repository<Entity>`, obtained via `@InjectRepository(Entity)` | Typed data access to one table |

How they relate, concretely: `main.ts` calls `NestFactory.create(AppModule)`, which
walks the whole module tree starting from `AppModule`'s `imports` array
(`app.module.ts:16-29`) and builds every provider it finds — feature modules first
register their repositories via `TypeOrmModule.forFeature([Entity])`, then their own
services (which inject those repositories), then their controllers (which inject
those services). By the time `app.listen()` runs, the entire object graph already
exists — nothing is built lazily per-request.

The one non-obvious relationship in this project: `ProductsModule` imports
`InventoryModule` (`products.module.ts:9`) to use `InventoryService`, but
`InventoryModule` (`inventory.module.ts`) never imports `ProductsModule` back — it
registers its own `TypeOrmModule.forFeature([InventoryTransaction, Product, Supplier])`
to get raw repositories for `Product`/`Supplier` (for row-locking and validation),
without needing `ProductsService`/`SuppliersService` at all. See
[nestjs-modules.md](nestjs-modules.md) for why that one-directional arrow was a
deliberate choice.

---

## 3. HTTP Request Lifecycle

The shape is the same for every write in this project:

```
HTTP Request → ValidationPipe → Controller → Service → Database → Response
```

### Create Product — `POST /products`

- **Validation**: `CreateProductDto` (`products/dto/create-product.dto.ts`) —
  `name`/`sku`/`unit` required non-empty strings, `categoryId`/`lowStockThreshold`
  optional integers.
- **Controller**: `ProductsController.create` (`products.controller.ts:34-37`) —
  `return this.productsService.create(dto);`
- **Service**: `ProductsService.create` (`products.service.ts:88-98`) — checks SKU
  uniqueness (`assertSkuAvailable`), then `productsRepository.save(...)`.
- **Database**: one `SELECT` (uniqueness check) + one `INSERT` on `products`, no
  transaction needed — nothing else can concurrently race a brand-new row.
- **Response**: the saved `Product` (`201`), without `currentStock`/`lowStock` —
  those only exist once `findAll`/`findOne` attach them (§1).

### Stock In — `POST /products/:id/stock-in`

- **Validation**: `CreateStockInDto` (`inventory/dto/create-stock-in.dto.ts`) —
  `quantity` integer `>= 1`, `occurredAt` ISO date string, `supplierId` optional integer.
- **Controller**: `InventoryController.recordStockIn` (`inventory.controller.ts:26-33`)
  — pulls `productId` (`@Param`), `dto` (`@Body`), and `userId` (`@CurrentUserId()`,
  a custom decorator reading the `x-user-id` header).
- **Service**: `InventoryService.recordStockIn` (`inventory.service.ts:130-151`) —
  opens a transaction, locks the product row, checks it's active, validates the
  supplier if given, inserts the transaction row.
- **Database**: row lock (`SELECT ... FOR UPDATE`) + `INSERT`, inside one transaction.
- **Response**: the new `InventoryTransaction` (`201`), `quantityDelta: +quantity`.

### Stock Out — `POST /products/:id/stock-out`

- **Validation**: `CreateStockOutDto` (`inventory/dto/create-stock-out.dto.ts`) —
  `quantity` integer `>= 1`, `occurredAt` required, `reason` optional string.
- **Controller**: `InventoryController.recordStockOut` (`inventory.controller.ts:35-42`).
- **Service**: `InventoryService.recordStockOut` (`inventory.service.ts:153-183`) —
  same lock-then-read pattern as Stock In, but additionally computes current stock
  *inside* the lock and throws `409 ConflictException` if `dto.quantity > currentStock`
  before inserting anything.
- **Database**: row lock + a `SUM(quantity_delta)` read + `INSERT`, one transaction.
- **Response**: the new transaction (`201`) with `quantityDelta: -quantity`, or `409`
  with the real remaining quantity in the message.

### Inventory Adjustment — `POST /products/:id/adjustments`

- **Validation**: `CreateAdjustmentDto` (`inventory/dto/create-adjustment.dto.ts`) —
  `newQuantity` integer `>= 0` (the client sends the counted **total**, not a delta —
  see the comment there and `docs/ui-open-questions.md` Q-UI-2), `reason` required
  non-empty string (BR-032).
- **Controller**: `InventoryController.recordAdjustment` (`inventory.controller.ts:44-51`).
- **Service**: `InventoryService.recordAdjustment` (`inventory.service.ts:185-224`) —
  locks the row **without** checking active status (adjustment is allowed on inactive
  products, Q-UI-1), computes `delta = newQuantity - currentStock`, rejects with `400`
  if `delta === 0` (a no-op).
- **Database**: row lock + read + `INSERT`, one transaction.
- **Response**: the new transaction (`201`) with the computed signed delta.

---

## 4. NestJS Core Concepts Used

### Modules
**What**: a class decorated `@Module({ imports, controllers, providers, exports })` —
a boundary declaration, not a place for logic.
**Why**: lets the DI container know what a chunk of the app offers/needs, so features
can be wired together (or tested in isolation) without manual construction.
**Where**: `app.module.ts` (root) + one module per feature
(`categories/`, `suppliers/`, `products/`, `inventory/`, `users/`, `dashboard/`).
**Interacts with**: everything — a provider that isn't in some module's
`providers`/`exports` simply doesn't exist to the DI container. See
[nestjs-modules.md](nestjs-modules.md).

### Controllers
**What**: `@Controller('path')` classes whose methods (`@Get()`/`@Post()`/etc.) map
routes to method calls.
**Why**: isolates "translate HTTP to a method call" from "do the actual work," so the
work is testable and reusable without HTTP.
**Where**: every `*.controller.ts`. `InventoryController` (`inventory.controller.ts`)
is the clearest example — three `@Post()` routes, each one line long, each forwarding
straight to `InventoryService`.
**Interacts with**: DTOs (via `@Body()`), Services (via constructor injection), custom
param decorators (`@CurrentUserId()`). See
[controllers-and-services.md](controllers-and-services.md).

### Providers
**What**: any class the DI container can construct and hand out — usually
`@Injectable()`.
**Why**: the general term for "a thing that can be injected" — Services, Repositories,
`ConfigService`, and the custom `AllExceptionsFilter` are all providers.
**Where**: `ProductsService`, `InventoryService`, `SuppliersService`,
`DashboardService`, `CategoriesService`, `UsersService` — one per feature, plus
TypeORM's generated repositories.
**Interacts with**: Modules (registration), DI (resolution), Controllers/other
Services (consumption).

### Dependency Injection
**What**: a class declares what it needs in its constructor; the container supplies
it.
**Why**: no manual wiring, singleton sharing by default, and — critically for this
project — swappable in tests. `suppliers.service.spec.ts` hands `SuppliersService` a
fake `Repository<Supplier>` in place of the real one, and the service's code never
knows the difference.
**Where**: every constructor in `backend/src`. The interesting one:
`ProductsService`'s constructor (`products.service.ts:28-32`) injects both
`Repository<Product>` **and** `InventoryService` — a provider injecting another
provider.
**Interacts with**: Modules (what's available to inject), Providers (what gets
injected). See [dependency-injection.md](dependency-injection.md).

### Services
**What**: `@Injectable()` classes holding business logic.
**Why**: keeps controllers thin and logic testable/reusable. `InventoryService`
(§5) is where every business rule in this project actually lives.
**Where**: one per feature module.
**Interacts with**: Controllers (called by), Repositories/`DataSource` (call into),
other Services (e.g., `ProductsService` → `InventoryService`).

### DTOs
**What**: plain classes describing request shape, decorated with `class-validator`
decorators.
**Why**: declarative validation instead of hand-written `if` checks per field, per
endpoint.
**Where**: every `dto/*.ts`. `CreateAdjustmentDto`
(`inventory/dto/create-adjustment.dto.ts`) is a good example of a DTO shape that
encodes a real design decision (counted total, not a raw delta).
**Interacts with**: `ValidationPipe` (checked by), Controllers (`@Body()` target).
See [dto-and-validation.md](dto-and-validation.md).

### ValidationPipe
**What**: a Pipe that runs before a controller method executes, validating/
transforming the request against a DTO.
**Why**: registering it once, globally, guarantees no future endpoint can forget it.
**Where**: registered once in `main.ts:22-29` with
`whitelist: true, forbidNonWhitelisted: true, transform: true`.
**Interacts with**: DTOs (the rules it checks), Controllers (runs before every one).

### Exception Handling
**What**: NestJS turns thrown `HttpException` subclasses into HTTP responses
automatically; `AllExceptionsFilter` (`common/filters/all-exceptions.filter.ts`)
catches everything else.
**Why**: services can `throw new ConflictException(...)` and never touch HTTP
directly; genuinely unexpected errors are prevented from leaking internals.
**Where**: thrown throughout every service (`NotFoundException`,
`ConflictException`, `BadRequestException`); caught globally by
`AllExceptionsFilter`, registered in `main.ts:31`.
**Interacts with**: Services (throw), the global filter (catch), the Response
(shape). See [exception-handling.md](exception-handling.md) and §8 below.

### Configuration
**What**: `ConfigModule`/`ConfigService`, reading `.env` into a typed object.
**Why**: one documented, typed place for env vars instead of scattered
`process.env.X`.
**Where**: `config/configuration.ts` (the one place `process.env` is read),
loaded via `ConfigModule.forRoot({ isGlobal: true, load: [configuration] })` in
`app.module.ts:18-21`; consumed by `DatabaseModule` (`database/database.module.ts:18-33`)
via `forRootAsync`.
**Interacts with**: `DatabaseModule` (needs config before it can connect), the test
suite (`test/app.e2e-spec.ts` relies on `ConfigModule`'s env-precedence behavior to
redirect at a separate database). See [configuration.md](configuration.md).

### Database Access
**What**: TypeORM entities (`*.entity.ts`) mapped to tables; `Repository<Entity>`
and `DataSource`/`EntityManager` for queries.
**Why**: typed access, migrations instead of `synchronize: true` (`database/
database.module.ts:29-31`), and (for `InventoryService`) transactional row locking.
**Where**: entities in each feature folder; `InventoryService` is the one place using
`DataSource.transaction()` directly instead of a plain injected repository. See
[database-access.md](database-access.md).

---

## 5. Business Logic

All business logic in this project lives in **services**, never controllers — and the
richest example is `InventoryService` (`backend/src/inventory/inventory.service.ts`).

- **Stock In** (`recordStockIn`, lines 130-151): validates the date isn't future,
  locks + checks the product is active, validates the supplier (if given) is active,
  inserts a `+quantity` transaction.
- **Stock Out** (`recordStockOut`, lines 153-183): same shape, plus reads current
  stock inside the lock and rejects (`409`) if the requested quantity exceeds it
  (BR-021).
- **Adjustment** (`recordAdjustment`, lines 185-224): locks without the active-status
  check (allowed on inactive products), computes `delta = newQuantity - currentStock`,
  rejects a no-op change (`400`).
- **Business rule validation**: every rule from `docs/business-rules.md` this phase
  touches (BR-011–013, BR-020–022, BR-030–034, BR-041) is enforced in exactly one of
  these three methods — not duplicated, not partially re-checked elsewhere.

**Why business logic doesn't belong in controllers**: `InventoryController`'s methods
(`inventory.controller.ts:26-51`) have no access to a `DataSource` or transaction
manager — only to `InventoryService`. Putting the lock-and-validate logic in the
controller would mean either exposing database internals to the HTTP layer, or simply
not being able to lock correctly at all. It would also mean any future second caller
of "record a stock-out" (a batch import, a scheduled job) would have to reimplement
the exact same lock/read/validate sequence correctly — or silently reintroduce the
race condition described in §7.

---

## 6. Database Transactions

`InventoryService`'s three write methods each open one with
`this.dataSource.transaction(async (manager) => { ... })` (e.g. line 136).

- **Transaction boundary**: starts at `this.dataSource.transaction(...)`, ends when
  the callback's returned Promise resolves (commit) or rejects (rollback). Everything
  inside — the row lock, the current-stock read, the insert — runs against the same
  `manager`, not the plain `@InjectRepository`-provided repository.
- **Commit**: happens automatically when the async callback returns successfully
  (e.g., after `insertTransaction` resolves in `recordStockOut`).
- **Rollback**: happens automatically if anything inside throws — e.g.,
  `ConflictException` thrown for insufficient stock (line 168) rolls back the whole
  transaction, so the row lock's read is discarded and nothing partial is ever
  committed.
- **Repository access inside a transaction**: `manager.getRepository(Product)`,
  `manager.getRepository(InventoryTransaction)`, and
  `manager.createQueryBuilder(InventoryTransaction, 'tx')` (`getCurrentStockLocked`,
  lines 249-259) — all obtained from the transaction's `manager`, which is what makes
  their reads/writes participate in the same transaction and see the row lock's
  effects.
- **Why inventory operations require transactions**: a transaction alone doesn't
  prevent the race in §7 — the *lock*, held for the transaction's duration, does. But
  the lock only means anything inside a transaction: outside one, "lock, read, write"
  would be three separate round trips with no guaranteed atomicity between them.

See [database-transactions.md](database-transactions.md) for the concept in general;
this section is that concept applied to this exact code.

---

## 7. Row Locking and Concurrency

**Scenario**: current stock = 10. Request A wants to stock-out 8. Request B wants to
stock-out 8, at nearly the same instant.

**Without locking**:
```
A: read stock → 10
B: read stock → 10          (A hasn't written yet)
A: 8 <= 10, OK → write -8
B: 8 <= 10, OK → write -8
Final stock = 10 - 8 - 8 = -6      ← BR-041 violated
```
Both requests decided based on a "current stock" that was already stale by the time
they wrote — the read and the write weren't atomic together.

**With `SELECT ... FOR UPDATE`** (`getLockedActiveProduct`, `inventory.service.ts:228-245`,
used by `recordStockOut` via line 160):
```
A: SELECT product FOR UPDATE  → lock acquired
B: SELECT product FOR UPDATE  → BLOCKS
A: read current stock (locked) → 10
A: 8 <= 10 → insert -8 → COMMIT (lock released)
B: lock acquired now, re-reads current stock → 2   (sees A's committed change)
B: 8 <= 2? NO → 409 ConflictException
Final stock = 2                    ← correct, never negative
```

- **Why the second request waits**: `pessimistic_write` (`lock: { mode: 'pessimistic_write' }`)
  is Postgres's `SELECT ... FOR UPDATE` — any other transaction trying to lock the
  same row blocks until the first transaction commits or rolls back. This is a
  database-level guarantee, not application code.
- **Why the second request sees the updated stock**: it doesn't re-read until *after*
  it acquires the lock, which only happens after A's transaction has already
  committed — so its read of `getCurrentStockLocked` reflects A's already-applied
  change, not a stale value.
- **Why this prevents overselling**: the check ("is quantity <= current stock?") and
  the write are effectively atomic per product, because nothing else can be reading
  or writing that product's stock in between.

This is proven, not just argued: `inventory.service.integration.spec.ts`'s
"does not oversell stock under concurrent stock-out requests for the same product"
test fires two real concurrent `Promise.all([...])` calls against a real Postgres
database and asserts exactly one succeeds, one gets `409`, and final stock is `5`
(never negative) — see §9.

---

## 8. Exception Flow

```
Service throws exception
   ↓
NestJS exception handling   (built-in: HttpException subclasses know their own status/shape)
   ↓
AllExceptionsFilter          (common/filters/all-exceptions.filter.ts)
   ↓
HTTP response                (JSON: { statusCode, message, error })
   ↓
Frontend                     (Store._request throws an Error with that message)
```

Concrete example — insufficient stock:

1. `InventoryService.recordStockOut` throws `new ConflictException('Only 2 case available — cannot remove 8.')` (`inventory.service.ts:168-170`).
2. `AllExceptionsFilter.catch` (`all-exceptions.filter.ts:29-36`) sees
   `exception instanceof HttpException` is true, and does
   `response.status(exception.getStatus()).json(exception.getResponse())` — passing
   the message straight through, unchanged.
3. The client receives `409` with
   `{ "statusCode": 409, "message": "Only 2 case available — cannot remove 8.", "error": "Conflict" }`.
4. `Store._request` (`frontend/index.html:341-357`) sees `!res.ok`, reads
   `data.message`, and `throw new Error(message)`.
5. The Stock Out wizard's `.catch(err => { ...; UI.toast(err.message, 'error'); render(); })`
   shows that exact message to the user.

Contrast with an unexpected error: if something throws a plain `Error` (not an
`HttpException`) — e.g., a dropped database connection — `AllExceptionsFilter` takes
the *other* branch (lines 38-45): logs the real detail server-side via `Logger`, and
responds with a generic `500` / `"Something went wrong. Please try again."`, never
exposing the actual exception message or stack trace to the client. This is the
distinction the filter exists to enforce — see
[exception-handling.md](exception-handling.md).

---

## 9. Testing

Three layers, each proving something the others can't:

- **Unit** — `suppliers.service.spec.ts`. Mocks the repository entirely
  (`{ provide: getRepositoryToken(Supplier), useValue: repo }`); no database, no
  HTTP. Fast, precise, but can't validate real database behavior.
- **Integration** — `inventory.service.integration.spec.ts`. Real PostgreSQL (a
  dedicated `smart_inventory_test` database, `database/test-data-source.ts`), no
  HTTP. This is the layer that exists specifically because a mocked repository has no
  concept of two transactions locking against each other.
- **E2E** — `test/app.e2e-spec.ts`. The real `AppModule`, real `ValidationPipe`, real
  `AllExceptionsFilter`, driven only through `supertest` HTTP calls against a third
  dedicated database (`smart_inventory_e2e`). Proves the layers are actually wired
  together — that a thrown `ConflictException` really becomes a `409` over real HTTP,
  not just in a unit test's expectations.

**The concurrent inventory test** (`inventory.service.integration.spec.ts`, "does not
oversell stock under concurrent stock-out requests for the same product") is the most
important test in this phase. It's why the integration layer exists at all: it fires
`Promise.all([attempt(8), attempt(8)])` against a product seeded with stock 13, and
asserts exactly one `'fulfilled'`, one `'rejected'` (a real `ConflictException`), and
a final stock of `5` — proving the row lock from §7 actually serializes concurrent
writers, against a real database, not a simulated one. No unit test (mocked
repository) or e2e test alone would prove this — see
[testing-strategy.md](testing-strategy.md) for why each layer was chosen deliberately.

---

## 10. How Everything Connects

```
Module
   ↓   (registers providers/controllers; exports what other modules may inject)
Dependency Injection
   ↓   (constructs Controllers and Services with what their constructors ask for)
Controller
   ↓   (@Body()/@Param() declare what a route needs; delegates to a Service)
DTO / Validation
   ↓   (ValidationPipe checks the DTO's decorators before the controller method runs)
Service
   ↓   (business logic; the only layer allowed to enforce a business rule)
Repository / Transaction
   ↓   (typed reads; DataSource.transaction() + row locks for anything concurrency-sensitive)
PostgreSQL
   ↓   (durable storage + a second layer of enforcement via @Check/FK constraints)
Exception Handling / Response
   (HttpException → AllExceptionsFilter → consistent JSON, success or failure alike)
```

- **Module → DI**: a provider only exists to the container if some module declares it
  (`providers`) and, if another module needs it, exports it (`exports`) — this is
  literally what makes `ProductsService` able to ask for `InventoryService`.
- **DI → Controller**: the container builds a `Controller` by resolving its
  constructor's dependencies first — a `Controller` never exists without its
  `Service` already built.
- **Controller → DTO/Validation**: a route's `@Body() dto: SomeDto` parameter is the
  signal the global `ValidationPipe` uses to know which decorators to check, before
  the controller's method body runs at all.
- **DTO/Validation → Service**: by the time a `Service` method receives a `dto`, its
  shape is guaranteed — the `Service` only has to worry about business-state
  validation (does this quantity exceed current stock?), not shape validation (is
  this even a number?).
- **Service → Repository/Transaction**: a `Service` either uses its plain injected
  repository (safe for non-concurrent operations, e.g. `ProductsService.create`) or
  opens a `DataSource.transaction()` when a row lock is required (`InventoryService`'s
  three write methods).
- **Repository/Transaction → PostgreSQL**: the actual SQL — `SELECT ... FOR UPDATE`,
  `INSERT`, `SUM(...)` — executes here; `@Check` constraints on
  `InventoryTransaction` are a second line of defense even if application code had a
  bug.
- **PostgreSQL → Exception Handling/Response**: whatever a `Service` decided (success
  or a thrown `HttpException`) is what actually reaches the client — `PostgreSQL`
  itself never talks to the client directly; everything flows back up through the
  same chain it came down.

---

## 11. What I Should Understand After Phase 2

- [ ] What is a Module, and what does `exports` actually control?
- [ ] What is a Controller, and why should it hold no business logic?
- [ ] What is a Provider?
- [ ] How does Dependency Injection work, and how does it resolve a chain like
      `ProductsService` → `InventoryService` → `DataSource`?
- [ ] Why use Services instead of putting logic in Controllers?
- [ ] What is a DTO, and what can it validate that a service-layer check can't (and
      vice versa)?
- [ ] How does `ValidationPipe` work, and what do `whitelist`/`forbidNonWhitelisted`/
      `transform` each do?
- [ ] How does exception handling work — the difference between an `HttpException`
      and what `AllExceptionsFilter`'s fallback branch is for?
- [ ] How does NestJS access PostgreSQL (entities, repositories, `DataSource`)?
- [ ] What is a database transaction, and what does "transaction boundary" mean
      concretely in `InventoryService`?
- [ ] Why is row locking necessary — what specifically goes wrong without it?
- [ ] How do Unit, Integration, and E2E tests differ, and which one would catch a
      broken row lock?

---

## 12. Review Questions

1. In `products.module.ts`, `ProductsModule` imports `InventoryModule`. What would
   break at startup if `InventoryModule` did not `export` `InventoryService`?
2. `CategoriesService` only has a `findAll()` method — no `create`. If the frontend
   needed to add a new category from the UI, which files would need to change, and in
   what order would you build that feature (entity → ? → ? → ?)?
3. `CreateStockOutDto` validates that `quantity` is an integer `>= 1`. Why can't this
   same DTO also validate that `quantity` doesn't exceed current stock? Where does
   that check actually happen, and why there?
4. `ProductsService.update` only re-checks SKU uniqueness when `dto.sku !== undefined
   && dto.sku !== product.sku` (`products.service.ts:104`). What would happen if that
   condition were simplified to just `if (dto.sku)`?
5. `InventoryService.recordAdjustment` locks the product row but does *not* call
   `getLockedActiveProduct` the way `recordStockIn`/`recordStockOut` do. What is the
   concrete consequence of that difference for a discontinued (inactive) product?
6. Walk through what happens, step by step, if `AllExceptionsFilter` were removed
   from `main.ts` entirely and a service threw a plain `new Error('db connection
   lost')` instead of an `HttpException`.
7. `getCurrentStockLocked` and `getCurrentStock` (`inventory.service.ts`) look almost
   identical — both `SUM(quantity_delta)` for a product. Why does one take a
   `manager` parameter and the other doesn't, and what would break if
   `recordStockOut` used `getCurrentStock` instead of `getCurrentStockLocked`?
8. In the concurrent stock-out test, why does the test assert `results.filter(r => r
   === 'rejected')` has length 1, rather than just asserting the final stock is
   correct? What class of bug would the final-stock-only assertion fail to catch?
9. `suppliers.service.spec.ts` mocks the repository; `inventory.service.integration.spec.ts`
   uses a real database. If you converted the concurrent-stock-out test to use a
   mocked repository the way the supplier test does, would it still be a meaningful
   test? Why or why not?
10. `ProductsModule` imports `InventoryModule` to compute `currentStock`. If a future
    requirement needed `SuppliersService` to also know a supplier's "total units ever
    supplied" (computed from `InventoryTransaction`), would you add that method to
    `InventoryService` and have `SuppliersModule` import `InventoryModule`, or would
    you take a different approach? What tradeoffs would guide that decision, given
    this project's existing module boundaries?
