# Database Transactions & Row Locking

## Concept

A **database transaction** groups multiple operations so they either all commit or
none do. A **pessimistic row lock** (`SELECT ... FOR UPDATE`) goes further: it makes
a second transaction that tries to read the *same row* wait until the first
transaction commits or rolls back, instead of reading a stale value concurrently.

## Why NestJS/TypeORM expose it

Application-level validation — "read current stock, check in JavaScript, then write"
— has a race condition baked in whenever two requests can run at once. This is not a
hypothetical: two staff members recording a stock-out for the same product at nearly
the same moment is entirely plausible in a real small business. Without a lock, both
requests can read the same "current stock = 10," both decide their own removal is
safe, and both succeed — overselling the product into negative stock, a direct BR-041
violation no amount of application-side `if` statements can prevent, because the read
and the write aren't atomic together.

## How it works in this project

`InventoryService`'s three write methods (`recordStockIn`, `recordStockOut`,
`recordAdjustment`, in `backend/src/inventory/inventory.service.ts`) all follow the
same shape:

```ts
return this.dataSource.transaction(async (manager) => {
  const product = await manager.getRepository(Product).findOne({
    where: { id: productId },
    lock: { mode: 'pessimistic_write' }, // SELECT ... FOR UPDATE
  });
  const currentStock = await this.getCurrentStockLocked(manager, product.id);
  // ...validate the business rule against currentStock...
  return this.insertTransaction(manager, { ... });
});
```

Locking the **product row**, not the transaction rows, is what serializes concurrent
writers for the same product: a second request's `findOne(..., { lock: ... })` simply
blocks until the first request's transaction commits, then re-reads — seeing the
first request's already-applied change before deciding whether its own write is
still valid.

## Example

`backend/src/inventory/inventory.service.integration.spec.ts` proves this against a
**real** PostgreSQL database (not a mock) by firing two concurrent 8-unit stock-outs
against a product with 13 units on hand:

```ts
const results = await Promise.all([attempt(8), attempt(8)]);
expect(results.filter(r => r === 'fulfilled')).toHaveLength(1);
expect(results.filter(r => r === 'rejected')).toHaveLength(1);
expect(await service.getCurrentStock(productId)).toBe(5); // never negative
```

This was also verified manually against the running dev server with two real
concurrent `curl` requests — see the phase transcript; the second request correctly
saw the first one's committed change and was rejected with `409`.

## Common Mistakes

- Reading current stock in one query, then writing in a separate, unlocked query "for
  simplicity" — this reintroduces the exact race condition above, even inside a
  transaction, because a transaction alone doesn't lock anything by default.
- Locking the *transaction* rows instead of the *product* row — two concurrent
  stock-outs for the same product don't share any existing transaction row to lock
  (each is inserting a brand-new one), so there's nothing there to serialize on. The
  product row is the one piece of shared state both requests need to touch.
- Testing this kind of logic only with a mocked repository. A mock can prove the
  *code path* runs; only a real database can prove the *lock* actually serializes
  concurrent access — hence the integration test above uses a real Postgres instance,
  not a mock.

## Key Takeaways

- A transaction alone doesn't prevent races — a lock held for the read-then-write
  duration does.
- Lock the row whose state the business rule depends on (here: the product), not an
  unrelated row.
- This is the single most important piece of business logic in this phase — it's the
  concrete mechanism behind BR-041 ("current stock can never be negative").
- Prove concurrency-sensitive logic with a real database test, not a mock.
