# Exception Handling & Exception Filters

## Concept

NestJS turns a *thrown* error into an HTTP response automatically. `HttpException`
and its subclasses (`NotFoundException`, `ConflictException`, `BadRequestException`, …)
already know what status code and JSON shape they should produce — a service can
`throw new NotFoundException('Product 7 not found.')` and nothing else needs to catch
it. An **Exception Filter** (`@Catch()`) is how you customize or extend that handling,
for errors NestJS's default behavior doesn't cover well.

## Why NestJS uses it

The built-in handling is exactly right for errors a service throws *on purpose*, to
report a business problem — the client needs that message. It's the wrong behavior
for an error nobody anticipated (a bug, a dropped connection): by default, an
unhandled non-`HttpException` error still becomes a `500`, but Nest's own default
formatting can end up echoing internal detail toward the response depending on the
error. A global filter is the one place to guarantee that distinction is enforced
consistently, everywhere, without every service needing its own try/catch.

## How it works in this project

`backend/src/common/filters/all-exceptions.filter.ts` is registered once, globally,
in `main.ts` (`app.useGlobalFilters(new AllExceptionsFilter())`):

```ts
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return; // pass through — the service meant to say this
    }
    this.logger.error('Unhandled exception', ...); // log the real detail server-side
    response.status(500).json({ statusCode: 500, message: 'Something went wrong. Please try again.' });
  }
}
```

Every business rule in this project is enforced by throwing a specific
`HttpException` subclass from a service — e.g. `InventoryService.recordStockOut`
throws `ConflictException` for insufficient stock, `ProductsService.remove` throws
`ConflictException` for delete-with-history, `SuppliersService.findOne` throws
`NotFoundException`. None of these needed a try/catch anywhere in the controller.

## Example

The filter's two branches are proven in two different places, deliberately:

- `all-exceptions.filter.spec.ts` calls `filter.catch()` directly with a plain
  `Error`, and asserts the response is the generic 500 (the original message never
  appears in it) while the real detail still reaches the server-side logger. This is
  the branch that actually needs proving, and there's no legitimate HTTP route in
  this app that throws a plain `Error` on purpose — every real rejection is a
  specific `HttpException` subclass — so a unit test against the filter itself is the
  only way to trigger it deterministically.
- `test/app.e2e-spec.ts`, "a pipe-rejected request never leaks a stack trace, over
  real HTTP", triggers `ParseIntPipe`'s `BadRequestException` and asserts the same
  "no stack frame" property over a real HTTP round trip. This proves the *other*
  branch (`instanceof HttpException` → pass its response through) is wired correctly
  end-to-end — it does **not** exercise the fallback branch, even though an earlier
  version of this test's name implied it did.

## Common Mistakes

- Wrapping every controller/service method in a manual try/catch "to be safe" — this
  duplicates what the global filter already does for free, and is easy to get subtly
  wrong (e.g. re-throwing a generic `Error` instead of the specific `HttpException`
  the client actually needs).
- Throwing a plain `Error` when a specific `HttpException` subclass exists — a plain
  `Error` is treated as "unexpected" by the filter above and becomes a generic 500,
  even if it was actually a normal, anticipated business-rule violation that should
  have been a 409 or 400.

## Key Takeaways

- Throw the *specific* `HttpException` subclass that matches the situation — Nest
  handles the response formatting.
- A global exception filter's job is mainly to catch what falls through: genuinely
  unexpected errors, which should never leak internal detail to the client.
- One filter, registered once, instead of defensive try/catch scattered everywhere.
