# Phase 3 Plan — Authentication & Session Handling

Status: Phase 3 — Built (see Definition of done below)
Last updated: 2026-08-20
Scope decided with the project owner: **authentication is Phase 3's focus, using
JWT (stateless tokens)** — closing FR-060, the one Must-have MVP requirement every
earlier phase deliberately left open. Category CRUD (FR-005) and other Should-have
polish stay out of this phase; revisit as Phase 4.

## Why this phase, why now

`docs/backend-use-cases.md` named this gap explicitly at the end of Phase 2:
*"a small `users` table... every write endpoint accepts an `x-user-id` header...
trusted as-is, not verified against a password or session... this phase implements
attribution without authentication."* It also named the exact seam where real auth
would plug in: the `CurrentUserId` decorator, which today just reads a
client-supplied header, becomes the place a Guard populates `request.user` from a
verified token instead. This phase builds that.

FR-061 (attribution) already works and does **not** change — every transaction
still records `recordedByUserId`. What changes is *where that id comes from*: a
verified JWT instead of an unverified header the client could set to anything.

---

## 1. Design decisions

Each decision below follows the same "why this, not that" format the project's
other docs use (`ui-open-questions.md`, `backend-use-cases.md`) — the reasoning is
part of the deliverable, not just the choice.

### Login identifier: email, not username
`User` currently has only `name` and `role` — no unique identifier suitable for
login. Add `email` (unique). This matches the pattern already established for
`Supplier.email` (`@IsEmail()`), and avoids inventing a second "username" concept
the product docs never mention.

### Token: a single JWT access token, no refresh token
A refresh-token pair is the "correct" production pattern, but it's real added
surface (a second token type, a revocation/rotation story, an extra endpoint) for
a single-location small-business tool where staff sign in once per shift. Matches
this project's existing precedent of deliberately not building the more complex
version of a feature until there's a real reason to (see
`architecture-observations.md`'s Kafka reasoning — same "don't build for a load
that doesn't exist" logic applies here to refresh tokens). One access token,
**12-hour expiry** (covers a full shift; short enough that a lost/leaked token
isn't a standing risk), issued at login. Re-login when it expires — no silent
refresh. If this ever becomes a real annoyance in practice, that's the concrete
evidence needed to justify adding refresh tokens (same "what evidence to look for"
framing the Go/Kafka section already models).

### Token transport: `Authorization: Bearer <token>` header, not a cookie
The frontend already sends a custom header on every write (`x-user-id`) — swapping
one header for another (`Authorization`) is a smaller, more legible change than
introducing cookie-based session handling, and keeps the API equally easy to drive
from `curl`/Postman the way `api.md` already documents. A cookie would also drag in
CSRF considerations this project has no other reason to take on yet.

### Password hashing: bcrypt
`argon2` is the more modern recommendation, but `bcrypt` is the more commonly
taught option, has a simpler API (no memory/parallelism tuning parameters to get
wrong as a learning exercise), and is more than adequate for this project's threat
model. Stored as `User.passwordHash`; the plaintext password never persists
anywhere, including the seed script (seeded demo users get hashed passwords, with
the plaintext documented once in `README.md`'s local-dev instructions, the same way
`.env.example` documents dev-only defaults today).

### No self-service signup
There is still no "create a user" use case (per `backend-use-cases.md`, unchanged).
Demo users are seeded with a password the same way they're seeded today; a real
user-management UI (invite staff, reset a password) is a Future item tied to A-5's
deferred role/permission model — building it now would mean guessing at
permissions this project has explicitly not designed yet.

### Guard rollout: global `JwtAuthGuard` + a `@Public()` escape hatch
Registered once as an `APP_GUARD` provider (same "register the cross-cutting thing
once, globally" pattern `ValidationPipe` and `AllExceptionsFilter` already
establish in `main.ts` — see `dto-and-validation.md` and
`exception-handling.md`), rather than a `@UseGuards()` decorator repeated on every
controller, for the same reason `dto-and-validation.md` gives for the global
`ValidationPipe`: it can't be forgotten on a new controller later. A tiny
`@Public()` custom decorator (built on Nest's `Reflector`, read by the guard)
exempts the one route that must stay open: `POST /auth/login`.

### `CurrentUserId` becomes trustworthy
Today (`common/decorators/current-user-id.decorator.ts`) it reads
`request.headers['x-user-id']` and trusts it outright. After this phase it reads
`request.user.id`, where `request.user` was set by Passport's JWT strategy *after*
verifying the token's signature — the decorator's code barely changes, but what it
returns goes from "whatever the client claimed" to "who the server cryptographically
verified." This is the exact seam the Phase 2 docs predicted.

### Logout: client-side only, no revocation list
Consistent with "no refresh tokens" above — a stateless JWT can't be revoked
server-side without adding the exact kind of server-side state a JWT is meant to
avoid. Logging out means the frontend discards the token. Documented as a known
limitation (a stolen token stays valid until it expires), acceptable at this
project's scale and explicitly flagged as a Future item if that ever needs to
change.

---

## 2. What's new

### Dependencies
`@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`, `bcrypt`, plus
`@types/passport-jwt` and `@types/bcrypt` (dev).

### `User` entity — two new columns
```ts
@Column({ unique: true })
email: string;

@Column({ name: 'password_hash' })
passwordHash: string;
```
New migration (`AddAuthToUsers`), following the existing reviewable-SQL pattern —
no `synchronize: true` shortcut. Seed script (`run-seed.ts`) updated to hash a
per-user dev password before inserting.

### New `AuthModule`
- `AuthService` — `validateUser(email, password)` (looks up the user, compares the
  password against the stored hash with `bcrypt.compare`) and `login(user)` (signs
  a JWT via `JwtService`, embedding `{ sub: user.id }`).
- `AuthController` — `POST /auth/login`, the one route marked `@Public()`.
- `JwtStrategy` (extends `passport-jwt`'s `Strategy`) — verifies the token's
  signature/expiry and its `validate()` method is what actually populates
  `request.user`.
- `JwtAuthGuard` — thin wrapper Nest/Passport expects, registered globally.
- `Public` decorator (`common/decorators/public.decorator.ts`) — sets Reflector
  metadata the guard checks.

### New endpoints

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `401` on wrong email/password (deliberately the same message either way — not revealing which one was wrong); `{ accessToken, user: { id, name, role } }` on success. The only route not requiring a token. |
| GET | `/auth/me` | — | Returns the caller's own user record, resolved from the token. Lets the frontend confirm a stored token is still valid on page load, and re-hydrate the "Signed in as..." UI without re-sending credentials. |

### Every existing write endpoint
No route signatures change, but every one of them now requires a valid
`Authorization: Bearer <token>` header instead of the old `x-user-id` header, which
is removed entirely once the guard is live (not left as a fallback — a fallback
would defeat the point).

---

## 3. Frontend changes

The Phase 1 mockup's static "Signed in as Jordan Lee · Staff" chip
(`ui-open-questions.md` Q-UI-4) is replaced with a real login form: email +
password, `Store.login()` calling `POST /auth/login`, the returned token held in a
plain JS variable in `Store`'s existing in-memory state (matching how the rest of
the frontend already avoids `localStorage` — see `Store`'s existing design, not a
new pattern). This means a page refresh logs the user out; that's an acceptable
MVP tradeoff for a single-page tool with no build step, not a bug — worth writing
down explicitly rather than leaving as an unstated limitation, the same way the
"no refresh token" decision above is written down.

`Store._request` gains one change: attach `Authorization: Bearer <token>` when a
token is held, and on a `401` response, clear it and route back to the login
screen — the one piece of actual new frontend logic this phase needs.

---

## 4. Testing plan

- **Unit** — `AuthService`: `validateUser` returns the user on a correct password
  and returns `null`/throws on a wrong one (mocked repository + a real `bcrypt`
  call against a precomputed hash, not a mocked `bcrypt` — hashing is cheap enough
  and the point is proving the actual comparison logic). `JwtStrategy.validate()`:
  given a decoded payload, returns the right shape for `request.user`.
- **E2E** (`test/app.e2e-spec.ts` and a new `test/auth.e2e-spec.ts`) —
  - login with correct credentials returns `200` + a token
  - login with wrong password / unknown email returns `401`
  - a protected route (e.g. `POST /products`) without a token returns `401`
  - the same route with a valid token succeeds
  - an expired/malformed token returns `401`
  - **every existing e2e test that currently calls a write endpoint** needs a
    `beforeEach` that logs in and attaches the resulting token — this is the
    single biggest mechanical change existing tests need, not new business logic.
- **No new integration-layer test.** Unlike `InventoryService`'s row locking, there
  is no concurrency-sensitive database behavior here for a mocked repository to
  fail to represent — password verification and token signing are pure,
  deterministic logic a unit test faithfully covers, consistent with
  `testing-strategy.md`'s own reasoning for *when* the integration layer earns its
  cost.

---

## 5. Rollout order

Sequenced so the app stays runnable at every step, rather than one big
all-at-once switch:

1. Migration + `User` entity fields + seed script (hashed dev passwords). App
   still runs exactly as before — nothing reads these columns yet.
2. `AuthModule` (`AuthService`, `POST /auth/login`, `JwtStrategy`) built and unit/
   e2e-tested **in isolation**, guard not yet registered globally. Login works;
   nothing else requires it yet.
3. Register `JwtAuthGuard` globally + `@Public()` on login + update
   `CurrentUserId`. This is the actual "flip the switch" step — every existing
   write endpoint now requires a token. Update all existing e2e tests in the same
   change (they will fail otherwise, which is exactly what should catch anything
   missed).
4. Remove the old `x-user-id` header path entirely from `CurrentUserId` and from
   `api.md` — no fallback left behind.
5. Frontend: login screen, `Store` token handling, remove the static
   "Signed in as" chip.
6. Docs: flip FR-060 to Done in `requirements.md`, add `docs/api.md`'s Auth
   section, add `docs/learning-notes/authentication-and-guards.md` (concept +
   "how it works in this project," matching every other learning-notes file's
   format), update `domain-model.md`'s User entity description (now has real
   credentials, not just an attribution stub).

---

## 6. Explicitly out of scope for Phase 3 (Future)

- Refresh tokens / token revocation or blacklisting.
- Password reset / "forgot password" flow (no email-sending infrastructure exists
  anywhere in this project yet — a real prerequisite, not just unbuilt).
- Role-based permissions beyond "authenticated or not" — A-5 stays deferred exactly
  as `product.md` already states; `role` on `User` remains descriptive, not
  enforced.
- Rate limiting / brute-force lockout on login attempts.
- Multi-factor auth.
- Self-service signup or an admin user-management UI.
- "Remember me" / long-lived sessions.

---

## 7. New NestJS concepts this phase introduces

Worth a `docs/learning-notes/authentication-and-guards.md` entry once built,
matching the existing notes' concept → why → how-it-works-here → common-mistakes
shape:

- **Guards** — where they sit in the request lifecycle (`Middleware → Guards →
  Pipes → route handler`), and the non-obvious consequence: a Guard runs *before*
  `ValidationPipe`, so it only ever sees the raw request (headers, raw body) —
  never a validated DTO. This is exactly why the JWT lives in a header, not a
  validated field.
- **Reflector + custom metadata** — how `@Public()` actually works: a decorator
  that attaches metadata to a route, and a Guard that reads it back via
  `Reflector` to decide whether to skip itself. The general mechanism behind a lot
  of Nest's own decorators, seen here for the first time from the inside.
- **`APP_GUARD`** — the token that registers a Guard globally via the providers
  array instead of `app.useGlobalGuards()` in `main.ts`, and why Nest needs a
  different mechanism for this than it does for pipes/filters (DI: a global guard
  built this way can itself have injected dependencies, e.g. `Reflector`).
- **Passport strategies** — `passport-jwt`'s `Strategy` as an adapter Nest wraps;
  `validate()` as the one method application code actually writes, and how its
  return value becomes `request.user`.
- **Hashing vs. encryption** — `bcrypt` is one-way by design; worth a short note on
  why "hash and compare" (never decrypt-and-compare) is the only correct password
  check.

---

## 8. Definition of done

- [x] `POST /auth/login` issues a JWT for correct credentials, rejects incorrect
      ones with `401` and no hint about which field was wrong.
- [x] Every existing write endpoint requires a valid token; `x-user-id` no longer
      does anything.
- [x] `CurrentUserId` reads a cryptographically verified user id, not a
      client-supplied one.
- [x] All existing tests updated and passing; new auth unit + e2e tests passing.
      (27 unit/integration + 14 e2e, all green — see `backend/test/auth.e2e-spec.ts`
      and `backend/src/auth/*.spec.ts`.)
- [x] Frontend has a real login screen; the static demo-user chip is gone.
      Verified with a real headless-browser run against the running backend:
      login form on load → wrong password shows an inline error → correct login
      reaches the dashboard with the real signed-in user → an authenticated
      products fetch succeeds → Sign out returns to the login screen → a direct
      hash change to a protected route while logged out still shows login.
- [x] `requirements.md`, `api.md`, `domain-model.md`, and a new
      `authentication-and-guards.md` learning note are updated to match.
- [x] Seeded demo users can log in locally with a documented password (see root
      `README.md`).
