# Authentication & Guards

## Concept

A **Guard** is a class that runs early in NestJS's request lifecycle and answers one
yes/no question: *should this request be allowed to reach its route handler at all?*
Guards sit here, relative to everything else:

```
Middleware → Guards → Interceptors (pre) → Pipes → Route Handler
```

The non-obvious consequence of that ordering: a Guard runs **before** `ValidationPipe`.
It only ever sees the raw request — headers, an unparsed body — never a validated DTO
instance. That's exactly why a JWT lives in the `Authorization` header rather than a
body field: by the time a Pipe could validate a body field, a Guard has already had to
decide whether the request is even allowed to proceed.

This project uses one Guard, `JwtAuthGuard` (`backend/src/auth/jwt-auth.guard.ts`), to
answer that question for every route in the app.

## Why NestJS uses it

Before Guards, "is this request authenticated?" would have to be checked inside every
controller method, or bolted on via middleware that has no clean way to short-circuit
with a proper HTTP response and status code. A Guard is purpose-built for exactly this:
it returns `true`/`false` (or throws), and NestJS turns a `false`/throw into a `403`/`401`
automatically, before any business logic runs.

## How it works in this project

### The global guard, and the one route that opts out

`JwtAuthGuard` is registered once, globally, as an `APP_GUARD` provider in
`auth.module.ts` — not repeated as `@UseGuards(JwtAuthGuard)` on every controller:

```ts
providers: [
  // ...
  { provide: APP_GUARD, useClass: JwtAuthGuard },
]
```

**`APP_GUARD`** is the special injection token Nest looks for to wire a provider in as
a *global* guard, applied to every route in the application. It's a different
mechanism from `app.useGlobalGuards()` in `main.ts` (which is how `ValidationPipe` and
`AllExceptionsFilter` are registered) for a specific reason: a guard registered as
`APP_GUARD` is built through Nest's dependency injection container like any other
provider, so it can have its own injected dependencies. `app.useGlobalGuards(new
JwtAuthGuard())` would construct the guard by hand, outside DI — and `JwtAuthGuard`
needs `Reflector` injected into it (see below), so that approach wouldn't work here.

Exactly one route needs to be reachable *without* a token: `POST /auth/login` — a
caller obviously can't present a token before they've logged in to get one. That's
where **Reflector + custom metadata** comes in. `@Public()`
(`common/decorators/public.decorator.ts`) is a tiny custom decorator:

```ts
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

`SetMetadata` attaches an arbitrary label to a route handler — by itself, that label
changes nothing. `JwtAuthGuard` reads it back via `Reflector` before deciding whether
to run its real check:

```ts
canActivate(context: ExecutionContext) {
  const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  if (isPublic) return true;
  return super.canActivate(context);
}
```

This is the same general mechanism a lot of Nest's own decorators are built on — a
decorator that tags a route, and something downstream (a Guard, an Interceptor) that
reads the tag back. Seen here for the first time from the inside, instead of just used.

### Passport strategies

`JwtAuthGuard extends AuthGuard('jwt')` — `AuthGuard` is a thin adapter `@nestjs/passport`
provides around whatever **Passport strategy** is registered under that name. Passport
is a much older, framework-agnostic Node.js authentication library; `passport-jwt`'s
`Strategy` (wrapped by `JwtStrategy` in `auth/jwt.strategy.ts`) handles pulling the
token out of the `Authorization` header and verifying its signature and expiry, all on
its own. The one method application code actually has to write is `validate()`:

```ts
validate(payload: { sub: number }): { id: number } {
  return { id: payload.sub };
}
```

`validate()` only runs *after* the token has already checked out — a request with a
missing, malformed, tampered, or expired token never reaches it; Passport rejects it
with `401` first. Whatever `validate()` returns becomes `request.user`, which is what
`CurrentUserId` (`common/decorators/current-user-id.decorator.ts`) then reads:

```ts
export const CurrentUserId = createParamDecorator((_, ctx) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user.id;
});
```

Before this phase, that same decorator read a client-supplied `x-user-id` header and
trusted it outright — nothing verified the caller actually *was* that user. The
decorator's code barely changed; what it returns went from "whatever the client
claimed" to "who the server cryptographically verified."

### Hashing vs. encryption

`AuthService.validateUser` compares a submitted password against `User.passwordHash`
using `bcrypt.compare()` — never by decrypting a stored value back to plaintext.
Hashing and encryption solve different problems: encryption is reversible (given the
right key, you get the original data back); a password hash is deliberately **one-way**.
Nothing — not even the application itself — can turn a bcrypt hash back into the
original password. The only way to check a guess is to hash the guess the same way and
compare the two hashes. That's the entire reason `bcrypt.compare(plaintext, hash)`
exists as its own function instead of "decrypt, then `===`": decrypt-and-compare would
require encryption (reversible, and therefore a much bigger liability if the database
ever leaks), when one-way hashing is both simpler and safer for this exact problem.

## Example

`auth.service.spec.ts` proves the hash comparison with a *real* `bcrypt.hashSync()`
call (not a mocked `bcrypt`) — the whole point of the test is proving the comparison
actually works, so faking the library under test would prove nothing.
`test/auth.e2e-spec.ts` proves the Guard/Strategy pipeline end-to-end over real HTTP:
a request with no token, a malformed token, and a token signed with a `-10s` expiry
(deliberately already-expired, but otherwise perfectly valid — isolating "expired"
from "wrong secret" or "malformed") all get `401`; a request with a fresh valid token
succeeds.

## Common Mistakes

- Registering a guard with `@UseGuards()` on each controller instead of once globally
  — easy to forget on a new controller later, the same reasoning
  `docs/learning-notes/dto-and-validation.md` gives for the global `ValidationPipe`.
- Reaching for `app.useGlobalGuards()` for a guard that needs injected dependencies —
  it bypasses DI, so anything the guard's constructor asks for (like `Reflector`) won't
  be there. Use an `APP_GUARD` provider instead.
- Putting a `@Public()`-equivalent check *inside* a controller method instead of
  letting the Guard skip itself — that still lets the (expensive, misleading) guard
  logic run first, and scatters the "is this route open?" decision across the
  codebase instead of keeping it in one place.
- Assuming `bcrypt.compare()` is slow because it "encrypts" — it's deliberately
  slow (it's a key-derivation-style hash, tuned by its cost factor) specifically to
  make brute-forcing many guesses expensive; that's a feature of hashing, not a sign
  something is being (mis)used as encryption.

## Key Takeaways

- A Guard decides *whether a request proceeds at all*, and runs before any Pipe —
  never assume a Guard sees validated input.
- Register cross-cutting guards once, globally, via `APP_GUARD` (not
  `app.useGlobalGuards()`) when the guard needs its own injected dependencies.
- `Reflector` + a custom `SetMetadata`-based decorator (`@Public()`) is the general
  mechanism for "let this one route opt out of a global behavior."
- A Passport strategy's `validate()` is the one piece of authentication logic this
  project actually writes; everything about verifying the token itself is handled by
  the library.
- Hash passwords, never encrypt them — `bcrypt.compare()`, not decrypt-and-compare.
