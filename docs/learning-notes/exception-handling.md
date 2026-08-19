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

`test/app.e2e-spec.ts`, "an unhandled error never leaks a stack trace to the client",
asserts the response body never contains anything that looks like a stack frame —
proving the filter's fallback path actually works over real HTTP, not just in theory.

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
