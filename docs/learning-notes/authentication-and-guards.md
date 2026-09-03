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
async validate(payload: { sub: number }): Promise<{ id: number; role: UserRole }> {
  const user = await this.usersService.findOne(payload.sub);
  return { id: user.id, role: user.role };
}
```

(Phase 5 added the lookup and the `role` field — see "Authorization" below. Before
that, `validate()` just returned `{ id: payload.sub }` synchronously, no database
access at all.)

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
using `verifyPassword()` (`src/common/password.ts`, a thin wrapper around
`bcrypt.compare()` — see "Where password hashing belongs" below for why it's a
standalone function rather than a method on `AuthService` itself) — never by
decrypting a stored value back to plaintext. Hashing and encryption solve different
problems: encryption is reversible (given the right key, you get the original data
back); a password hash is deliberately **one-way**. Nothing — not even the
application itself — can turn a bcrypt hash back into the original password. The
only way to check a guess is to hash the guess the same way and compare the two
hashes. That's the entire reason `bcrypt.compare(plaintext, hash)` exists as its own
function instead of "decrypt, then `===`": decrypt-and-compare would require
encryption (reversible, and therefore a much bigger liability if the database ever
leaks), when one-way hashing is both simpler and safer for this exact problem.

### Authorization is a different question than authentication

Everything above answers *who is this?* — a Guard (`JwtAuthGuard`) and a Strategy
(`JwtStrategy`) that turn a bearer token into a trustworthy `request.user`.
Phase 5 (`docs/phase-5-plan.md`) adds a second, genuinely different question on top:
*is this **specific, already-identified** user allowed to do **this**?* That's
**authorization**, and it gets its own Guard, `RolesGuard`
(`backend/src/auth/roles.guard.ts`), rather than being folded into `JwtAuthGuard`.
Keeping them separate isn't just tidiness — a request that fails authentication and a
request that fails authorization are different failures with different HTTP codes
(`401` vs. `403`) and different fixes for the caller (log in again, vs. nothing you can
do without a different role), so conflating them into one Guard would blur that
distinction in the response itself.

**Multiple `APP_GUARD` providers.** `auth.module.ts` now registers *two* guards this
way:

```ts
providers: [
  // ...
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
]
```

`APP_GUARD` isn't a single-slot token — registering it twice adds a second global
guard rather than replacing the first. Nest runs every registered guard for every
request, **in the order their providers were registered**, and a request must pass
*all* of them to reach its handler.

**Why registration order is load-bearing here.** `RolesGuard.canActivate` reads
`request.user.role` — but that property doesn't exist until `JwtAuthGuard`'s Passport
strategy has already run and populated it (see "Passport strategies" above). If
`RolesGuard` were registered *before* `JwtAuthGuard`, it would run first, find no
`request.user` on every single request (even ones with a perfectly valid token, since
its Guard hasn't run yet), and deny everything. This is exactly the kind of dependency
that's invisible from reading either Guard's code in isolation — nothing about
`RolesGuard.canActivate` signals "I need to run second." The comment at the
registration site in `auth.module.ts` is the only thing that makes it visible, which is
why it's there.

**A third guard, and a third reason order matters (Phase 8).** `AppThrottlerGuard`
(`backend/src/auth/app-throttler.guard.ts`) joins the array as the **first** of
three:

```ts
providers: [
  // ...
  { provide: APP_GUARD, useClass: AppThrottlerGuard }, // 1st
  { provide: APP_GUARD, useClass: JwtAuthGuard },       // 2nd
  { provide: APP_GUARD, useClass: RolesGuard },         // 3rd
]
```

The reasoning is different from *why* `JwtAuthGuard` precedes `RolesGuard` (a data
dependency — one guard populates what the next one reads) but the *shape* of the
lesson is the same: **global guard order is a real API of the providers array, not
an implementation detail**, and here it's a cost-ordering argument instead of a
data-ordering one. A flood of requests should be rejected as cheaply as possible —
before a database lookup (`JwtAuthGuard`/`JwtStrategy.validate`), and certainly
before a `bcrypt` comparison (`AuthController.login`). A throttler registered *after*
`JwtAuthGuard` would still let every request in a flood pay for that lookup before
being rejected; registered after `RolesGuard` too, it would pay for a role check as
well. Registering it first means an over-limit request never reaches either.

## Rate limiting vs. account lockout — two different questions (Phase 8)

Easy to conflate, because both react to "too many login attempts," but they answer
different questions and neither substitutes for the other:

| | Request throttle | Account lockout |
|---|---|---|
| Question | *How fast can anyone try?* | *How many times can one account fail in a row?* |
| Scope | Per client address, per route | Per account, follows it across addresses |
| Protects | The server (CPU, connections) | The user (their specific account) |
| Storage | In-memory (`ThrottlerModule`) | Postgres (`users.failed_login_attempts`/`locked_until`) |
| Beaten by | An attacker who is patient or distributed | A password-spray attack (one guess each, across many accounts) |

A throttle alone is beaten by an attacker willing to go slow, or to spread requests
across many source addresses. A lock alone lets someone hammer the login endpoint at
full speed across *many different accounts* — one guess each, never triggering any
single account's threshold — which is a more realistic attack against a small
business than a deep brute force against one inbox. The two compose: the throttle
caps the *rate* regardless of which account is targeted, the lock caps the *damage*
to any one account regardless of how the attempts are spread out in time.

One more thing the pairing buys for free: the throttle also pays for the lock's one
real cost. `AuthService.validateUser` still runs `bcrypt.compare()` even for an
account that's already locked (see the ordering rule below for why it has to), which
means a locked account still burns real CPU per attempt — that's exactly the cost
the request throttle exists to cap, by rejecting a flood before it ever reaches that
comparison at all.

## The enumeration-ordering rule, generalized

Phase 6 introduced a rule for the deactivated-account message: `AuthService.validateUser`
checks `user.status` strictly *after* `verifyPassword` has already succeeded, never
before. Phase 8's lock check follows the identical shape, immediately after it:

```ts
const user = await this.usersRepository.findOne({ where: { email: normalizeEmail(email) } });
if (!user) return null;                              // unknown email → generic 401
const matches = await verifyPassword(password, user.passwordHash);
if (!matches) {                                       // wrong password → generic 401
  await this.usersService.registerFailedLogin(user);
  return null;
}
if (user.status === EntityStatus.INACTIVE) throw /* deactivated message */;
if (this.usersService.isLocked(user)) throw /* lock message, with minutes remaining */;
await this.usersService.clearLoginFailures(user);
return user;
```

Two instances of the same check are worth stating as the general rule they actually
are: **a specific, informative failure message is safe to show exactly when reaching
it requires knowledge the caller doesn't have.** Both the deactivated message and the
lock message are only reachable *after* the correct password has already been
supplied — so an attacker who doesn't know the password can never distinguish "wrong
password," "unknown email," "deactivated," or "locked" from each other; all four
collapse to the same generic `401` from the outside. A caller who *does* know the
password gets the specific, useful message, because at that point they've already
proven they're not an anonymous enumerator. The rule generalizes to any future
account-state check this function might grow: put it after the password comparison,
never before, or it becomes a way to probe which emails exist without ever guessing
a password right.

An easy mistake this rule specifically forecloses: registering a failed login (the
counter that can eventually lock the account) *before* checking whether the password
even matched. `registerFailedLogin` only ever runs in the `!matches` branch — an
attacker who already knows the correct password, and is only being blocked by
`status`/lock, never adds to that counter, because they didn't fail. Only an actual
wrong guess counts as a failure.

## The actor/subject distinction (Phase 9)

Phase 9 (`docs/phase-9-plan.md`, an audit log) needed to record *who did this* on
every write, and the naive first draft is one column: `userId`. `validateUser`'s own
failure path is the case that breaks it, and it's worth walking through because the
bug it avoids is a **modeling** mistake, not a coding one — it would compile, pass a
type checker, and still be wrong.

A failed login for a known email finds a real row in `users`. The intuitive move is
to write that row's id into the new column: *someone* failed to log in as Jordan, so
`userId: jordan.id`. That's a lie. The person who typed the wrong password is, in the
one case an audit log of failed logins exists for, precisely **not** Jordan — Jordan
already knows their own password. One column that means "the account this event
matched" in a failed-login row and "the person who did this" in every other row is
worse than no audit log at all, because a reader has no way to tell which meaning a
given row is using; they'd read every row as the second, since that's what "who did
this" usually means.

The fix is naming the two facts separately instead of merging them: **`actor`** (the
authenticated principal who performed the action — `null` when nobody authenticated,
which is exactly the failed-login case) and **`subject`** (the account this event is
*about* — set whenever an email matched, even on failure). A failed login for a known
email is `actor: null, subject: <the user>`. An Owner deactivating Riley is `actor:
Alex, subject: Riley`. A self-service password change is the one case where they
legitimately coincide (`actor: subject: <the same user>`), and it coincides because
the fact really is symmetric, not because the columns were secretly one column all
along.

This generalizes past this one table: **when a column's meaning would depend on
which branch of the code wrote it, that's a sign it's actually two facts wearing one
name, and the fix is to name them separately, not to document the ambiguity better.**
It sits beside the enumeration-ordering rule above as a second instance of the same
underlying discipline — *being precise about what a piece of data actually proves* —
applied to a schema decision instead of a response-timing one. A `login_failed` row's
`actor` proves nothing (nobody authenticated); its `subject`, when set, proves only
"this email matched an account," never "this person did anything." Reading either
column as claiming more than that is the exact mistake a merged `userId` column would
have made structurally impossible to avoid.

**`@Roles()` is default-open; the absence of `@Public()` is default-closed — and
that's intentional, not inconsistent.** `@Public()` marks the *rare* exception (one
route, `POST /auth/login`) against a *strict* default (every route needs a token) — so
the default has to be closed, or a route added later without thinking about auth would
silently be reachable with no token at all. `@Roles(UserRole.Owner)` marks the *rare*
restriction (ten specific write routes) against a *permissive* default (any
authenticated user can do most things) — so the default has to be open, for the mirror
image reason: a route added later without thinking about roles should behave like its
neighbors (open to any signed-in user), not fail closed with a confusing `403` nobody
asked for. Same mechanism (`SetMetadata` + `Reflector`, see above), opposite default,
because the two decorators are guarding opposite-shaped rules.

```ts
canActivate(context: ExecutionContext): boolean {
  const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  if (!required || required.length === 0) return true; // no @Roles() → open
  const { user } = context.switchToHttp().getRequest();
  if (!user) return false; // belt-and-braces; JwtAuthGuard already ran
  if (required.includes(user.role)) return true;
  throw new ForbiddenException('This action requires the Owner role.');
}
```

Throwing `ForbiddenException` instead of just returning `false` matters for the same
reason `AuthController.login` throws a specific message rather than letting Nest's
generic default through: Nest turns a bare `false` into a generic "Forbidden resource"
message, which tells a legitimately confused Staff user nothing about *why*. The
explicit exception carries a message that says why, and `AllExceptionsFilter` passes
it through unchanged.

### Class-level vs. route-level guard metadata — and when each is right

`RolesGuard` reads `@Roles()` metadata with
`this.reflector.getAllAndOverride(ROLES_KEY, [context.getHandler(), context.getClass()])`
— it was always able to read the decorator from *either* the individual route handler
or the whole controller class; nothing about the Guard changed between Phase 5 and
Phase 6. What changed is which one actually gets decorated, and that choice isn't
cosmetic — it's a statement about the controller's shape.

`ProductsController` and `SuppliersController` apply `@Roles(UserRole.Owner)`
*per route*, because those controllers are genuinely mixed: `GET` stays open to any
authenticated user, while `POST`/`PATCH`/`DELETE` are Owner-only. A class-level
decorator there would lock the reads too — wrong behavior, not just wrong style.
`UsersController` (Phase 6, `docs/phase-6-plan.md` §1) is the opposite shape: *every*
route on it, including `GET`, is Owner-only (BR-074), so it gets exactly one
`@Roles(UserRole.Owner)` at the class level:

```ts
@Roles(UserRole.Owner)
@Controller('users')
export class UsersController { /* six routes, no per-route @Roles() at all */ }
```

The general rule this leaves behind: **decorate at the narrowest level that's still
uniform.** A controller with a uniform rule gets one class-level decorator, so a
seventh route added later inherits it automatically instead of relying on whoever adds
that route to remember to repeat it. A controller with a genuinely mixed rule gets
per-route decorators, because a class-level one would silently be wrong for the routes
that are supposed to differ. This is also why `PATCH /auth/password` — open to *any*
authenticated user, not Owner-only — lives on `AuthController` rather than as
`PATCH /users/me/password`: putting it on `UsersController` would force that
controller's class-level decorator back to a per-route one, just to carve out a single
exception, and lose the property the class-level form exists for.

### Where password hashing belongs, and why the module graph forces it there

Phase 6 adds two new places that need to hash or compare a password:
`UsersService.create`/`setPassword` (hashing) and
`UsersService.changeOwnPassword` (comparing, for the `currentPassword` check). The
obvious-looking option — have `UsersService` call `AuthService`, which already knows
how to hash and compare — doesn't compile, and the reason is worth understanding
rather than working around blindly.

`auth.module.ts` imports `UsersModule`:

```ts
@Module({
  imports: [TypeOrmModule.forFeature([User]), UsersModule, PassportModule, /* ... */],
  // ...
})
export class AuthModule {}
```

Nest's module graph is directed: `AuthModule` depends on `UsersModule`. If
`UsersService` also depended on `AuthService` (from `AuthModule`), the graph would
have an edge running both ways — a **circular dependency** between modules, which Nest
either refuses to resolve or resolves in a fragile, load-order-sensitive way,
neither of which is worth having for two one-line functions.

The fix is to notice that hashing and comparing a password aren't really *auth logic*
at all — they're a stateless transformation (`hashPassword(plain)`) and a stateless
comparison (`verifyPassword(plain, hash)`) that don't need a database, a request, or
either service's other dependencies. Pulling them out to a plain module,
`src/common/password.ts`, sidesteps the cycle entirely: both `AuthService` and
`UsersService` import the same two functions, and neither service imports the other.
The general lesson: a circular *module* dependency is often really a sign that some
piece of logic was placed inside a service when it belonged in neither — extracting it
to a dependency-free function can dissolve the cycle instead of requiring you to pick
which direction "wins."

### An authorization fix that quietly became a revocation mechanism

Phase 3 explicitly declined to build token revocation: logout is client-side only (the
token is just forgotten), and there's no server-side list of "tokens that are no
longer valid" for a Guard to check against. That was a deliberate simplicity trade,
not an oversight — building one means either a database table of revoked tokens
checked on every request (defeating a lot of the point of a stateless JWT) or a
short-lived-token-plus-refresh-token scheme (real complexity for a project this size).

Separately, Phase 5 changed `JwtStrategy.validate` to look the user up by id on
*every* authenticated request, purely so `role` could be read fresh from the database
instead of trusted from the token payload — a fix for a stale-role problem
(`docs/phase-5-plan.md` §1), nothing to do with revocation at all.

Phase 6 needed exactly one form of revocation: *this person's access should stop*,
right now, not at their token's next expiry (`docs/phase-6-plan.md` §1). Adding it
turned out to cost nothing, because Phase 5's per-request lookup was already loading
the one row that would need to change:

```ts
const user = await this.usersService.findOne(payload.sub) /* ... */;
if (!user) throw new UnauthorizedException('This account no longer exists.');
if (user.status === EntityStatus.INACTIVE) {
  throw new UnauthorizedException('This account has been deactivated.');
}
return { id: user.id, role: user.role };
```

One `if` on a field that was already sitting in memory. The general shape worth
naming: **a per-request database lookup, once you have one, is a hook other features
can attach to for free** — the marginal cost of one more field check on an
already-loaded row is close to zero, even though building that same lookup *from
scratch*, just to get this one property, would have been a much bigger decision (the
exact trade Phase 3 weighed and declined). It's a reminder to look at what an existing
design decision already bought before assuming a new requirement needs new
infrastructure. What this does *not* provide, and still doesn't: revoking one specific
token while leaving the rest of that user's sessions alone. That's the general
revocation problem Phase 3 declined, and it's still declined — this only ever acts on
*the person*, by flipping a row every request already reads, never on a token.

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
- Registering `RolesGuard` before `JwtAuthGuard` in the `APP_GUARD` providers array —
  it would run first, see no `request.user` yet, and deny every request regardless of
  token validity. Order in that array is the order Nest runs global guards in.
- Registering `AppThrottlerGuard` anywhere but first — a flood would still pay for a
  database lookup (`JwtAuthGuard`) or a role check (`RolesGuard`) before being
  rejected, defeating the point of rejecting it cheaply (Phase 8).
- Checking `isLocked(user)` (or `status`) *before* `verifyPassword` "to save a hash
  comparison" — it looks like a harmless optimization and it reopens the exact
  enumeration hole Phase 3 closed: an attacker could then tell a locked/deactivated
  account from an unknown email without ever guessing the password.
- Letting a failed attempt against an *already-locked* account extend the lock (e.g.
  "reset the timer on every failure") — the intuitive implementation, and wrong: it
  turns a defensive feature into a permanent, attacker-triggered outage. A lock must
  have a fixed expiry set once, not a rolling one.
- Putting the role in a JWT's payload and skipping the database lookup, to save a query —
  cheaper, but means a demoted user keeps their old role's powers until their token
  expires, since nothing forces re-issuing a token on a role change. This project reads
  `role` fresh from the database on every request specifically to avoid that (see
  `JwtStrategy.validate`).
- Applying `@Roles()` class-level "for consistency" on a controller whose routes
  genuinely differ (e.g. `ProductsController`, where `GET` must stay open) — that
  silently locks routes that were never supposed to be restricted. Class-level is only
  correct when the rule really is uniform across every route on the controller.
- Reaching for a service-to-service call (`UsersService` calling `AuthService`, or vice
  versa) to reuse two lines of hashing logic, without checking the module import
  graph first — `AuthModule` already imports `UsersModule`, so the reverse call would
  be a circular module dependency. A dependency-free shared function
  (`src/common/password.ts`) avoids the question entirely.

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
- Authentication (*who is this?*) and authorization (*what can they do?*) are
  different questions, get different Guards, and fail with different codes (`401` vs.
  `403`) — don't fold one into the other.
- Multiple `APP_GUARD` providers all run, in registration order, and a request must
  pass every one of them — order the array so guards that populate `request.user` run
  before guards that read it.
- A permissive default (`@Roles()` open, like most of this app's routes) and a strict
  default (`@Public()` closed, like `JwtAuthGuard`'s) can coexist deliberately — pick
  the default that matches which case is the *exception* for that particular rule.
- Decorate at the narrowest level that's still uniform: class-level `@Roles()` when
  every route on a controller shares the same rule (`UsersController`), per-route when
  they genuinely differ (`ProductsController`) — the wrong choice either silently
  over-restricts or relies on remembering to repeat a decorator.
- A circular module dependency is often a sign that some logic belongs in neither
  service — pulling it out to a dependency-free function (`src/common/password.ts`)
  can dissolve the cycle instead of forcing a choice of which direction "wins."
- A per-request database lookup added for one reason (role freshness) can become the
  hook a later, unrelated feature (session revocation on deactivation) attaches to for
  free — worth checking what an existing design decision already bought before
  assuming a new requirement needs new infrastructure.
- Global guard order is a real API, not an implementation detail — it can encode a
  *data* dependency (`RolesGuard` needs what `JwtAuthGuard` populates) or a *cost*
  dependency (`AppThrottlerGuard` should reject cheaply before anything expensive
  runs); both are reasons order matters, and neither is visible from reading one
  guard's code in isolation.
- Rate limiting and account lockout answer different questions and neither
  substitutes for the other — a throttle caps *how fast anyone can try*; a lock caps
  *how many times one account can fail in a row*. Combine them; don't pick one.
- A specific, informative error message is safe to show exactly when reaching it
  requires knowledge an attacker doesn't have (the password) — generalize this rule
  to every account-state check a login function grows, not just the first one.
- When a column's meaning would depend on which code path wrote it (Phase 9's
  `actor`/`subject` split), that's two facts wearing one name — name them
  separately rather than documenting the ambiguity, or a reader has no way to tell
  which meaning a given row is using.
- **Role-based and ownership-based authorization are different mechanisms, and a
  guard that only sees the request cannot implement the second.** Phase 12's
  `PATCH /adjustment-requests/:id/status` is the first route in this app whose legality
  is not fully expressible as `@Roles(...)`: withdraw is allowed only for *the
  requester of this row*, approve/reject only for an Owner who is *not* the requester.
  `RolesGuard` reads `request.user.role` and nothing about the row, so the rule that
  compares the actor to a column on the target lives in `AdjustmentsService.resolve`,
  after the row is loaded — not because the guard is the wrong place for role checks,
  but because "the actor's relationship to this specific record" is a question a guard
  reading only the token cannot answer. Keep the `@Roles()` gate for the part that is
  purely role, and put the ownership comparison in the service beside the data it
  compares against.
