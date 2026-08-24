# Phase 8 Plan — Login Rate Limiting & Account Lockout

Status: Phase 8 — Complete
Last updated: 2026-08-24
Scope decided with the project owner: **make repeated failed authentication attempts
expensive — a global request throttle in front of the auth endpoints, and a temporary,
self-clearing lock on an account that has failed too many times in a row** — and nothing
else. Scoped the same way `phase-3-plan.md` was scoped to authentication,
`phase-5-plan.md` to authorization, `phase-6-plan.md` to user management, and
`phase-7-plan.md` to audit timestamps: one headline change, an explicit out-of-scope
list, no punch-list riding along.

## Why this phase, why now

This is the only item two previous phases deferred **by name**. Phase 5 §7:

> **Rate limiting, audit log of denied attempts, account lockout** — adjacent security
> work, none of it asked for, none of it required by the two-role split.

Phase 6 §7 came back to it and said what to do about it:

> **Rate limiting and account lockout on failed logins** — still out, and worth saying
> why now that it is more tempting: this phase adds a password-verification endpoint
> (`PATCH /auth/password`), which is a second place to guess at a password. But it is a
> place that already requires a valid token, so it is not an anonymous attack surface,
> and rate limiting is a cross-cutting concern (a global guard or middleware, a store,
> a policy) that deserves its own phase rather than a corner of this one.

This is that phase. Nothing about the system's threat model changed since Phase 6 — what
changed is that the deferral reasoning has run out. `POST /auth/login` has been an
unlimited, unauthenticated, unmetered password oracle since Phase 3. Every seeded
account shares an eight-character dev password. `bcrypt` at cost factor 10 is the *only*
thing currently slowing an attacker down, and slowing an attacker down is not what
bcrypt is for — it is what makes each guess cost ~100ms of **this server's** CPU, which
is a cost the attacker imposes and does not pay.

Two things also make this the right phase to do *now* rather than later:

- **Phase 6 gave the system its first real reason to have accounts worth attacking.**
  Before it, every account came from `npm run seed` and roles were set in `psql`. Now an
  Owner creates accounts, sets their initial passwords by hand (Phase 6 §1: "the Owner
  types the initial password rather than the system generating one"), and the password
  policy is deliberately `@MinLength(8)` and nothing else — "a floor, not a policy."
  Hand-typed 8-character passwords are exactly the population that brute force beats.
- **Phase 6 also built, for a different reason, the precedent this phase needs.**
  `users.status` established that "an account that exists but cannot authenticate right
  now" is a state this system already models, checked in exactly the two places it has
  to be (`AuthService.validateUser` and `JwtStrategy.validate`). A lock is a second,
  narrower instance of that same idea, and §1 spends most of its length on the ways it
  is *not* the same — because merging them would be the easy mistake.

One framing makes the whole phase coherent and is worth stating before any decision:
**throttling and lockout answer different questions and neither substitutes for the
other.** A throttle caps *how fast anyone can try*, knows nothing about whose account is
being attacked, and protects the server. A lock caps *how many times one account can
fail in a row*, follows the account across IP addresses, and protects the user. A
throttle alone is beaten by an attacker who is patient or distributed; a lock alone lets
someone hammer the endpoint at full speed across many accounts (one guess each — the
password-spray attack that is far more realistic against a small business than a deep
brute force against one inbox). The two compose, and the composition is the design.

---

## 1. Design decisions

### The lock is temporary and self-clearing — never a flag an Owner has to come and clear

**Five consecutive failures locks the account for fifteen minutes, and the lock expires
on its own.** No Owner action is required to restore it, and there is no permanent
"locked" state.

This is the single most important decision in the phase, and the argument for it is
specific to this product rather than general security advice. BR-075 guarantees that at
least *one* active Owner exists — it does not guarantee two, and in a 1–10 person
business (A-1) one is the normal case. A permanent lock that only an Owner can clear
therefore has a reachable state where the sole Owner is locked out of their own system
and the only recovery is a `psql` prompt. That is precisely the state Phase 6 existed to
eliminate ("a business owner who hires someone cannot give them an account… every one of
those is a `UPDATE users SET …` today, run by whoever has database access — which in a
1–10 person business is nobody"). A time-based lock cannot produce it: the worst case is
that the Owner waits fifteen minutes.

The security cost of auto-expiry is small and quantifiable. Five attempts per fifteen
minutes is twenty guesses an hour, about 175,000 a year — against even a weak
hand-chosen password, that is not a serious brute-force budget. Permanence would buy
very little and risk a great deal.

### A lock must not become a denial-of-service weapon — so failures during a lock never extend it

Any account lockout hands a stranger who knows an email address the ability to lock that
account. In a business where the Owner's email is on the invoices, that is not
hypothetical. Three properties keep the damage bounded, and the third is the one that is
easy to get wrong:

1. **The window is short and self-healing** (fifteen minutes), so the maximum harm from
   one round of malice is one coffee break.
2. **An Owner's password reset clears the lock** (`PATCH /users/:id/password`, §2). This
   is not a new route — it is the action an Owner would take anyway when a colleague
   says "I can't get in," and making it also clear the lock means one route instead of
   two. A separate `PATCH /users/:id/unlock` is deliberately **not** added: it is a
   route whose only user is an Owner who has already been told to wait fifteen minutes.
3. **A failed attempt against an already-locked account does not extend the lock.** The
   counter stops at the threshold. Without this, an attacker scripting one guess a
   minute keeps an account locked *forever*, which converts a defensive feature into a
   permanent outage anyone can trigger. This is the difference between a lock and a
   ban, and the code needs a comment saying so, because "reset the timer on every
   failure" is the intuitive implementation and it is wrong.

Rejected: **exponential backoff per account** (5 min, then 15, then an hour…). It is
more state, harder to explain to a user standing at a counter, and its whole benefit is
against the deep single-account brute force that the flat fifteen-minute window already
prices out of existence.

### The lock message stays generic *unless the password was correct* — the Phase 6 ordering rule, reused

Phase 6 §1 made the deactivated-account message deliberately non-generic, and could
afford to because of *where the check ran*: after `verifyPassword` had already succeeded,
so reaching the message required already knowing the password. This phase faces the same
question with the opposite pressure, because **a lock is reached by failing**, which is
exactly what an enumerator does. A naive "This account is locked" tells an
unauthenticated stranger that the email exists — reopening, from a new direction,
precisely the hole Phase 3 closed by making unknown-email and wrong-password return an
identical `401`.

The resolution is to reuse the ordering, not to abandon the helpful message:

```
user = findByEmail(email);          if (!user)  return null;            // generic 401
matches = await verifyPassword(password, user.passwordHash);
if (!matches) { await registerFailedLogin(user); return null; }         // generic 401
if (user.status === INACTIVE)  throw Deactivated;                       // Phase 6
if (isLocked(user))            throw Locked(minutesRemaining);          // Phase 8
await clearLoginFailures(user);
return user;
```

An attacker who does not know the password only ever sees the generic `401` and cannot
tell a locked account from a wrong guess from a nonexistent email. A legitimate user who
typed their own password correctly gets "Too many failed attempts. Try again in 12
minutes," which is the one message that actually helps them. The deactivated check stays
ahead of the lock check because deactivation is the more durable fact: an Owner switched
this account off, and telling someone about a fifteen-minute timer on an account that is
administratively closed would be misleading.

**The cost of this ordering is real and worth naming**: bcrypt runs even for an account
that is already locked, so a locked account still burns ~100ms of CPU per attempt. That
cost is exactly what the IP throttle exists to cap — it rejects the request *before* the
controller, so a flood never reaches the hash comparison at all. Throttle protects the
CPU, the lock protects the account, and the ordering protects against enumeration. Each
of the three is load-bearing and none of them does another's job.

### The counter lives in two columns on `users` — not in memory, and not in a new table

- **`failed_login_attempts`** — `INTEGER NOT NULL DEFAULT 0`, the count of *consecutive*
  failures. Reset to `0` by any successful login and by an Owner's password reset.
- **`locked_until`** — `TIMESTAMP NULL`, the moment the lock expires. `NULL` means "not
  locked," and a value in the past means the same thing, so nothing has to sweep expired
  locks.

**Not in memory.** The app is single-process today, so a `Map` would technically work —
and would silently reset every counter on every restart or deploy, which makes the
feature a lie exactly when someone is attacking. State that must survive a restart goes
in Postgres.

**Not a new `login_attempts` table.** A table of attempt rows is an *audit log of
authentication attempts* — the other half of what Phase 5 §7 deferred ("audit log of
denied attempts"), and a genuinely different feature: who tried, from where, when, and a
screen to read it on. Two columns answer the only question this phase asks, which is
"can this account log in right now." Building the table instead would be the punch-list
rider these plans reject; it stays in §7.

A consequence worth stating: **an unknown email has nothing to count against**, so it can
never be locked. That is not a gap — there is no account there to protect, and the volume
is the IP throttle's problem, not the lock's.

Plain `TIMESTAMP` for `locked_until`, matching every other server-set timestamp in the
schema per the `domain-model.md` §8 convention. It is not an audit column (it is
operational state, not a record of when something happened), but it is server-set and
never user-supplied, and starting a `timestamptz` island here would be exactly the
mid-schema second convention Phase 7 §7 refused to start.

### `DEFAULT 0` and `NULL` are what keep the existing tests untouched — the Phase 6/7 lesson, a third time

Every e2e spec seeds users with a raw `INSERT INTO users (name, role, email,
password_hash) …` that names no other column — `app.e2e-spec.ts`, `auth.e2e-spec.ts`,
`categories.e2e-spec.ts`, `roles.e2e-spec.ts`, `users.e2e-spec.ts`. `failed_login_attempts
INTEGER NOT NULL DEFAULT 0` and a nullable `locked_until` mean none of those inserts
mention the new columns and none of them break. This is the same property `DEFAULT
'active'` bought in Phase 6 and `DEFAULT now()` bought in Phase 7, for the same reason,
and it is why the migration needs no add-then-constrain dance.

### The throttle is keyed by IP, and the login limit is tighter than the global one

Two limits, both per-IP, both configurable (§2):

| Scope | Limit | Why |
|---|---|---|
| Global default (every route) | 120 requests / 60s | A generous backstop. The frontend's busiest screen — a dashboard load that fetches a summary, products, and transactions — is a handful of requests; 120 a minute is far above any human's use and far below a useful attack rate. |
| `POST /auth/login` | 10 attempts / 300s | The anonymous surface. Ten tries in five minutes is more than a person who has forgotten which password they used needs, and it caps a single IP at 120 guesses an hour regardless of how many accounts it spreads them across. |
| `PATCH /auth/password` | 10 attempts / 300s | The second password-verification surface Phase 6 §7 named. Same limit; see below for why it gets a throttle and no lock. |

**Keyed by IP, not by submitted email.** The obvious refinement — key the login bucket on
`ip + req.body.email`, so one person fumbling their own password can't throttle a
colleague behind the same office NAT — is rejected, because it makes a password-spray
attack (one guess against each of fifty accounts) completely invisible to the throttle: every
bucket sees one request. Spray is the more realistic attack against a small business
than a deep brute force against one account, and the flat per-IP key is the one that
sees it. The shared-office cost is acceptable at this scale: ten login attempts per five
minutes across a whole 1–10 person office is still comfortably more than a normal
morning needs, and the *global* 120/60s limit is per-IP too, sized so a shared office
never approaches it.

**A deployment note, not a code change**: `req.ip` is only meaningful if Express is told
whether it sits behind a proxy. It runs directly today, so `req.ip` is honest. If this
is ever deployed behind a load balancer or reverse proxy without `app.set('trust proxy',
…)`, every request will appear to come from one address and the throttle will lock out
the world. That belongs in `.env.example`'s comments and the README, not in the code.

### `PATCH /auth/password` gets a throttle and deliberately **no** lock

Locking someone out of their own account because they mistyped their *current* password
is punishment that stops no attack. The caller already holds a valid token — an attacker
who has the token does not need the password for anything this API offers (there is no
step-up authentication, no route that re-verifies). The only realistic guesser here is
the account's actual owner, fumbling. A throttle caps the abuse case; a lock would only
ever hurt the legitimate user. Stated explicitly because "apply the same rules to both
password endpoints" is the symmetric-looking, wrong answer — the same shape of reasoning
Phase 7 used to refuse an `updated_at` on `inventory_transactions` "for consistency."

### The throttler guard runs **first**, which is why it lives beside the other two

`AuthModule`'s providers array already carries a load-bearing comment about global guard
ordering: `JwtAuthGuard` is registered before `RolesGuard` because `RolesGuard` reads
`request.user`, which only exists once Passport has populated it. The throttler joins that
array as the **first** of three, because rejecting a flood before any database lookup
happens is the entire point — a throttler that ran after `JwtAuthGuard` would still let
every request in the flood cost a `JwtStrategy.validate` primary-key lookup.

There is a real, admitted smell here: throttling is not an authentication concern, and
`AuthModule` is not obviously its home. The alternative — providing it from `AppModule`
— makes the relative ordering of `APP_GUARD` providers across two modules depend on
module import order, which is exactly the kind of invisible coupling the existing comment
exists to prevent. Keeping all three registrations in one array, in one place, with one
comment explaining the order, is worth the misplaced-module cost. The comment should say
that this is why.

One consequence of running first: `request.user` does not exist yet, so a custom tracker
cannot key `PATCH /auth/password` by user id even though that route is authenticated.
Per-IP it is, for both. Noted rather than worked around.

### A `429` has to fit the error shape `api.md` promises — and by default it doesn't

A concrete finding from reading the code rather than an anticipated risk.
`AllExceptionsFilter` does `response.status(exception.getStatus()).json(exception.getResponse())`,
and `ThrottlerException.getResponse()` returns a plain **string**, not an object. So a
throttled request would serialize as a bare JSON string instead of the
`{ statusCode, message, error }` shape `api.md`'s preamble documents for every error —
and the frontend's `Store._request`, which reads `data.message`, would fall through to
its generic `Request failed (429).`, discarding the one piece of information the response
carried.

Fixed by overriding `throwThrottlingException` in a small `AppThrottlerGuard` subclass so
it throws a normal `HttpException({ statusCode, message, error }, 429)` with a human
message ("Too many requests. Please slow down and try again shortly."). Deliberately
**not** fixed by teaching `AllExceptionsFilter` about `ThrottlerException`: that file's
job is the "expected vs. unexpected error" boundary, and patching one library's response
shape inside it would blur a well-commented seam for a problem that belongs to the guard
that creates it. The `Retry-After` header the throttler sets survives either way, because
the filter writes to the same response object — worth asserting in a test rather than
assuming.

### Locked is not deactivated, and the frontend's 401 heuristic already handles both

Two states, two columns, two messages, and they must not be merged:

| | `status = 'inactive'` (Phase 6) | `locked_until > now()` (Phase 8) |
|---|---|---|
| Cause | An Owner decided | The account failed five times |
| Duration | Until an Owner reverses it | Fifteen minutes, automatically |
| Existing token | Rejected on the next request (BR-077) | **Still valid** — see below |
| Message | Distinct, specific | Distinct, but only after a correct password |

**A lock does not revoke an existing session.** `JwtStrategy.validate` gains *no* lock
check. This is deliberate and is the sharpest line between the two states: deactivation
means "this person may no longer be here," which is a statement about the person and must
reach every open tab immediately (BR-077, and the reason Phase 5's per-request lookup
turned out to pay for revocation). A lock means "someone is guessing at this password,"
which is a statement about the *login endpoint* — logging out an Owner who is mid-task
because a stranger guessed at their password on another continent would convert a small
nuisance into a real one, and would hand that stranger the ability to interrupt work
rather than merely delay a login. `JwtStrategy.validate` stays exactly as it is.

On the frontend, `Store._request` treats a `401` outside `/auth/login` as a dead session
and bounces to the login screen. The lock `401` only ever arrives *on* `/auth/login`,
which is already excluded — it surfaces inline on the login form like a wrong password
does, which is correct. A `429` is not a `401` and falls through to the generic throw,
which the forms already display. **No `Store._request` change is required**, and the
existing comment about not folding `403` into the `401` branch should gain `429` by name,
so the next person does not fold it in.

### Configuration, not constants — and the e2e suite is the reason it matters

Thresholds go in `configuration.ts` and `.env.example` alongside `jwtExpiresIn`, which is
the existing precedent for "a policy number that a deployment might reasonably change."
But the decisive reason is testing: **the e2e suites fire dozens of requests in seconds
and will trip any throttle tuned for humans.** The limits must be settable per
environment, the e2e config must raise them (or the lockout window shorten to a second or
two, which is also what makes the auto-expiry actually testable — §5), and rollout step 1
exists to prove the existing suite stays green before anything else lands. This is the
same regression this phase is most likely to cause and most cheaply prevents, in the same
place Phases 6 and 7 put it.

### Where the write lives: `UsersService`, called from `AuthService`

`AuthService` currently only ever *reads* `users`. Registering a failed login makes it a
writer, and the lock also has to be cleared from `UsersService.setPassword` (an Owner's
reset). Two places writing the same two columns is exactly the drift risk that made
Phase 6 pull bcrypt into `common/password.ts`.

So the two mutations live as public methods on `UsersService` —
`registerFailedLogin(user)` and `clearLoginFailures(user)` — called by `AuthService` and
by `setPassword`. The dependency direction is already legal and already used:
`AuthModule` imports `UsersModule`, `UsersModule` exports `UsersService`, and
`AuthController` injects it today. This is the `assertOwnerRemains` pattern — one helper,
called from every path that can touch the invariant, so the paths cannot drift apart.

**Read-then-write, not transaction-wrapped**, with the same acknowledgement
`assertOwnerRemains` already carries: two simultaneous failed logins for one account can
race and record one increment instead of two. At the scale this product targets that is
not worth a row lock, and the failure mode is an attacker occasionally getting a sixth
guess — not a correctness violation. One sentence in the code, not a transaction.

### One flagged scope fork: the email-casing bug in the function this phase edits

Found while reading `AuthService.validateUser`, not introduced by this phase.
`UsersService.normalizeEmail` lowercases every email at write time — its comment explains
why at length — but `validateUser` looks up `findOne({ where: { email } })` with the raw
input. Postgres `=` is case-sensitive, so **`Alex@example.com` cannot log in today**, and
the comment claiming the login lookup "was already exact-match" is describing the bug
rather than a decision.

This is not a security hole and this phase does not create it: a case-mismatched email
finds no user at all, so it cannot be used to dodge the lock. But it is a login failure
in the exact function this phase is editing, and Phase 8 makes it *more* confusing rather
than less — a user who capitalizes their email now gets a permanent, unexplained "Invalid
email or password" while never accumulating a lock or an explanation.

House discipline says a rider gets in only when the phase creates the risk (Phase 6 §1
admitted `password.ts` on exactly that ground). This phase doesn't. So it is flagged here
as **the one real scope fork**, with a recommendation to include it: it is a single call
to the existing `normalizeEmail` at the lookup, plus one e2e assertion, in a function this
phase is already rewriting. If the owner prefers a clean single-headline phase, it moves
to §7 as a recorded, known defect instead — and should be recorded rather than silently
left, either way.

### No new FR — the Phase 7 precedent, for a different reason

`requirements.md` is explicitly a *functional* requirements document, and this phase adds
no user goal from `product.md` §4. Nobody's job is "resist password guessing"; the
capability is that logging in keeps working while attacking it stops working. Following
Phase 7's precedent, the phase adds **no FR** and records the absence with its reason, so
the requirements table isn't quietly inflated with a security control. The rules
themselves — where they are genuinely rules — go to `business-rules.md` as BR-079–081,
which is where BR-074–078 already put the authentication and account rules from Phase 6.

---

## 2. What's new (backend)

### Dependency

`@nestjs/throttler` — the framework's own rate-limiting package, so it participates in
the guard pipeline rather than sitting in front of it as Express middleware. Default
in-memory storage; see §4 for the multi-instance caveat that gets parked, not solved.

### `users` gains two columns + migration

```ts
// Phase 8 (docs/phase-8-plan.md §1). Consecutive failures — reset to 0 by any
// successful login and by an Owner's password reset, NOT decayed over time.
@Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
failedLoginAttempts: number;

// NULL, or a time in the past, both mean "not locked" — nothing sweeps expired locks.
@Column({ name: 'locked_until', type: 'timestamp', nullable: true })
lockedUntil: Date | null;
```

Both are `@Exclude()`d from serialization. Unlike Phase 7's timestamps — which §1 of that
plan argued were safe to expose everywhere, including the nested `recordedBy` on every
transaction read — these are operational security state, and a `GET /products` response
should not tell every authenticated user which colleague is currently locked out or
close to it. The Owner-visible presentation (§3), if it ships, reads them through an
explicit, Owner-only shape rather than by un-excluding the columns.

New migration `…-AddLoginLockoutToUsers.ts`, any timestamp sorting after
`1787470000000-AddAuditTimestampsToUsersAndCategories` (e.g. `1787560000000`):

```
up:
  ALTER TABLE "users" ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0
  ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMP NULL

down:
  ALTER TABLE "users" DROP COLUMN "locked_until"
  ALTER TABLE "users" DROP COLUMN "failed_login_attempts"
```

One step each, no backfill, no `SET NOT NULL` dance — `DEFAULT 0` is the backfill for the
first and the second is nullable by design. A header comment records why (same shape as
Phase 7's migration comment) and why the columns keep every existing raw `INSERT INTO
users (…)` in the five e2e specs working untouched.

### `configuration.ts` + `.env.example`

```ts
security: {
  maxFailedLoginAttempts: number;   // AUTH_MAX_FAILED_ATTEMPTS, default 5
  lockoutMinutes: number;           // AUTH_LOCKOUT_MINUTES,     default 15
  throttleTtlSeconds: number;       // THROTTLE_TTL_SECONDS,     default 60
  throttleLimit: number;            // THROTTLE_LIMIT,           default 120
  loginThrottleTtlSeconds: number;  // THROTTLE_LOGIN_TTL_SECONDS, default 300
  loginThrottleLimit: number;       // THROTTLE_LOGIN_LIMIT,       default 10
}
```

The same typed-single-place pattern the file's own header comment describes. `.env.example`
gains all six with comments, including the `trust proxy` deployment warning from §1.

### `ThrottlerModule.forRootAsync` in `AppModule`

Registered with `ConfigService` for the same reason `JwtModule` and `DatabaseModule` use
the async form: the limits come from config, not from values fixed at module-load time.
The module registration lives in `AppModule` (it is app-wide); the **guard** registration
lives in `AuthModule` beside the other two, per §1.

### `AppThrottlerGuard`

A four-line subclass of `ThrottlerGuard` overriding `throwThrottlingException` to throw a
normal `HttpException` with the documented `{ statusCode, message, error }` body (§1). It
gets its own comment explaining that the override exists because the default exception's
`getResponse()` is a string, which `AllExceptionsFilter` would pass straight through.

### `AuthModule` — a third global guard, registered first

```ts
providers: [
  AuthService,
  JwtStrategy,
  // FIRST, deliberately: rejects a flood before JwtAuthGuard's per-request database
  // lookup and before AuthController reaches bcrypt at all (docs/phase-8-plan.md §1).
  { provide: APP_GUARD, useClass: AppThrottlerGuard },
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
],
```

The existing ordering comment is extended, not replaced — it already explains why order
matters here, and this adds a third reason to the same explanation.

### `AuthController` — two `@Throttle()` overrides

`POST /auth/login` and `PATCH /auth/password` each get the tighter login limit from
config. Everything else inherits the generous global default. `@SkipThrottle()` appears
nowhere.

### `AuthService.validateUser` — the ordering from §1

The existing comment block about the deactivated-account ordering is *extended*, not
rewritten: it is already the canonical explanation of why status is checked after the
hash comparison, and the lock check is the same argument applied to a second state. The
new text says why the lock message is safe to be specific (it is only ever reached by a
caller who supplied the correct password) and why the lock check sits after the
deactivated check.

`login()` is unchanged. `JwtStrategy.validate` is unchanged — see §1.

### `UsersService` — two new methods, one changed one

- `registerFailedLogin(user)` — increments the counter; when it reaches the configured
  threshold **and the account is not already locked**, sets `lockedUntil = now +
  lockoutMinutes`. Never extends an existing lock (§1). Needs `ConfigService` injected,
  which `UsersService` does not have today.
- `clearLoginFailures(user)` — zeroes the counter and nulls `lockedUntil`.
- `setPassword(id, newPassword)` — an Owner's reset now also clears the lock, on the same
  `save()`. One comment explaining that this *is* the unlock mechanism and why there is no
  separate unlock route.
- `changeOwnPassword` — **unchanged**, deliberately. It has no lock to clear (§1: no lock
  on that route) and adding one would imply a state that doesn't exist.

### `run-seed.ts` — no change

Users are created through `repository.create`/`save`, so the column default and the
nullable column both apply. Every seeded account starts unlocked with a zero counter,
which is correct — and unlike Phase 6's deliberately-inactive Riley, there is **no
deliberately-locked demo user**: a seeded lock would expire fifteen minutes into the demo
and look like a bug, and the state is trivial to reproduce by typing a wrong password
five times.

### No DTO, no new route, no controller signature change

`LoginDto` and `ChangePasswordDto` are untouched; no request body carries lock state (and
the global `ValidationPipe`'s `forbidNonWhitelisted` would `400` anything that tried); no
role rule mentions these columns. As in Phase 7, the emptiness of this list is a property
of the design, not a gap in the plan.

---

## 3. Frontend changes

Deliberately minimal, and mostly a matter of confirming that nothing needs to change.

**In scope — confirmations, one comment, one optional screen change:**

- **The login form already displays the lock message correctly.** A locked-account `401`
  arrives on `/auth/login`, which `Store._request`'s `sessionIsDead` check already
  excludes precisely so a wrong password renders inline instead of triggering a
  "session expired" redirect. The lock message rides that same path. Verify; change
  nothing.
- **`Store._request` gains `429` by name in the existing 403 comment.** That comment
  explains why a `403` must not be folded into the `401` session-death branch; a `429`
  needs exactly the same protection for exactly the same reason (the session is fine,
  the server is just saying "slow down"), and naming it is cheaper than re-deriving the
  argument later.
- **Optional: a "Locked" badge on `Views.userList`.** When an Owner is told "I can't get
  in," the useful screen is the one that says whether the account is locked, deactivated,
  or neither — three states that produce the same complaint. This needs an Owner-only way
  to read `lockedUntil` (the columns are `@Exclude()`d per §2), which is the one piece of
  real work in this section: either `UsersController`'s read shape gains an explicit
  `locked: boolean` on the already-Owner-only `GET /users`, or the badge doesn't ship.
  A boolean, not the timestamp — an Owner needs to know *that* it is locked, and the
  remedy (reset the password, or wait) doesn't depend on the minutes.

**Out of scope — explicitly:**

- **No countdown timer or live-updating "unlocks in 12:43".** The message states the
  minutes remaining at the time of the attempt; a ticking clock is a live-updating widget
  for a fifteen-minute wait, and Phase 7 §3 already ruled out relative-time formatting for
  the same reason.
- **No client-side attempt counting or "3 attempts remaining" warning.** The server is the
  only thing that knows the count, and a client-side approximation would be wrong the
  moment the same account is attempted from a second device — worse, it would tell an
  attacker exactly how many guesses they have left.
- **No unlock button.** §1 — an Owner's password reset is the unlock, and it already
  exists.
- **No throttle-aware retry, backoff, or request queueing in `Store`.** A `429` is an
  error the user sees, not something the client silently retries around.

If the owner would rather ship this phase **backend-only** — the throttle, the lock, the
documented rules, no UI at all — that is a coherent stopping point, since everything above
is either a no-op confirmation or the optional badge. Flagged here as the second scope
fork in the phase (the first is the email-casing fix in §1).

---

## 4. Documentation updates

1. **`business-rules.md`**, extending the Authorization section (which already houses
   BR-070–078, the authentication and account rules from Phases 5 and 6):
   - **BR-079** — **Authentication attempts are rate-limited.** Requests to
     `POST /auth/login` and `PATCH /auth/password` are capped per client address per
     window; exceeding the cap returns `429` and the request never reaches password
     verification. A generous global cap applies to every other route as a backstop.
   - **BR-080** — **Consecutive failed logins lock an account temporarily.** N
     consecutive failures lock it for T minutes; the lock expires on its own, a
     successful login resets the counter, and **further failures during a lock do not
     extend it**. An Owner's password reset (BR-078) clears a lock; there is no other
     manual unlock, and no permanent lock exists — a lock that only an Owner could clear
     would have a state where the last active Owner (BR-075) is locked out of their own
     system with no recovery.
   - **BR-081** — **A lock is not a deactivation, and never reveals whether an account
     exists.** A locked account's specific message is returned only after the supplied
     password has already matched; every other failure returns the same generic `401` as
     an unknown email (Phase 3). Unlike deactivation (BR-077), a lock does **not** revoke
     an existing token — it blocks obtaining a new one.
   - **BR-078** gains one sentence noting that an Owner's reset also clears a BR-080
     lock, so the two rules cross-reference rather than sitting apart.
   - The "Rules Explicitly Deferred" list keeps its Q-6 line unchanged.

2. **`api.md`** — title bumped to Phase 8. The preamble's error-shape paragraph gains
   `429` ("too many requests — includes a `Retry-After` header; same
   `{ statusCode, message, error }` shape as every other error"), and the `401`-vs-`403`
   note gains a third line for it. The `POST /auth/login` row gains the lockout behavior
   and, importantly, the fact that the lock message is only reachable with a correct
   password; `PATCH /auth/password` gains its throttle and a note that it is deliberately
   *not* subject to lockout. No route table changes beyond those two rows.

3. **`requirements.md`** — a short **"Authentication hardening (Phase 8 — no new FR)"**
   note, mirroring the "Audit Timestamps (Phase 7 — no new FR)" section immediately above
   it: this is a security control with no user goal from `product.md` §4 behind it, the
   rules live in `business-rules.md` BR-079–081, and recording the *absence* of an FR with
   its reason keeps the functional-requirements table honest.

4. **`architecture-observations.md`** — a new cross-cutting note, and a genuinely useful
   one for that file's purpose ("what the implementation actually revealed"): **the
   throttle's counters live in the throttler's default in-memory store, while the lockout's
   live in Postgres.** Single-process today, so both are correct. The moment this app runs
   as more than one instance, the lock keeps working unchanged and the throttle silently
   becomes per-instance — an N-instance deployment would permit N× the configured rate.
   That is a real, specific thing to look for before scaling out, in the same spirit as the
   file's existing "what evidence to look for before extracting anything" section, and it
   is parked beside the Phase 7 `timestamptz` question as a known latent issue, not solved.

5. **`docs/learning-notes/authentication-and-guards.md`** — extended again rather than
   joined by a new file, consistent with Phases 5 and 6. Three additions:
   - **Guard order, now with three.** The file already covers the global guard and the
     `@Public()` opt-out; this adds why a throttler must be the first of the three, and
     the general lesson that global guard order is a real API of the providers array.
   - **Rate limiting vs. lockout** — the §1 framing: two mechanisms, different questions,
     neither substituting for the other, and how each one covers the other's cost (the
     throttle pays for the bcrypt call the ordering rule forces).
   - **The enumeration-ordering rule, generalized.** The file already explains the Phase 6
     deactivated-message ordering. This turns that one case into the rule it actually is:
     *a specific failure message is safe exactly when reaching it requires knowledge the
     attacker doesn't have* — which is why "deactivated" and "locked" can both be specific
     while "unknown email" cannot.

6. **`README.md`** — Current phase section updated. The sign-in table is unchanged, but it
   gains one line in the same spirit as the existing Riley note: **five wrong passwords
   lock a demo account for fifteen minutes, and that is the feature working, not a broken
   seed.** A developer who fat-fingers `password123` a few times while testing should not
   spend an afternoon debugging the seed. Also a one-line `trust proxy` warning for anyone
   deploying this behind a proxy.

7. **`backend/.env.example`** — the six new variables with comments (§2).

---

## 5. Testing plan

Three properties here are easy to get silently wrong — a lock that never expires, a lock
that an attacker can extend forever, and a specific message that leaks account existence
— and each gets a pinning test.

- **Unit — `auth.service.spec.ts`** (extended; the file already mocks the repository and
  deliberately does **not** mock bcrypt, for the reason its own comment gives):
  - A locked account **with the correct password** → the lock message.
  - A locked account **with a wrong password** → the *generic* message, not the lock one.
    This is the ordering pin, and it is the exact analogue of the assertion Phase 6 added
    to stop someone "simplifying" the status check to the top of the method. Without it, a
    future refactor that checks the lock first passes every other test in this file.
  - The Nth consecutive failure sets `lockedUntil`; the (N−1)th does not.
  - A failure **while already locked** leaves `lockedUntil` unchanged — the anti-permanent-
    DoS property from §1, which no other test would catch.
  - A successful login clears both columns.
  - An unknown email increments nothing and throws nothing new.

- **Unit — `users.service.spec.ts`** (extended): `setPassword` clears both `lockedUntil`
  and `failedLoginAttempts`; `changeOwnPassword` deliberately does not touch either.

- **E2E — `auth.e2e-spec.ts`** (extended, real Postgres, using the file's existing
  harness):
  - **The full lockout round trip**: N wrong passwords, then the *correct* password → `401`
    with the lock message. Then, with the e2e environment's lockout window set to a
    second or two, wait it out and log in successfully with the same correct password —
    the assertion that proves the lock actually expires rather than merely being set. A
    fifteen-minute production default is untestable; a configurable window is what makes
    the auto-clear provable, which is half the reason §1 put the thresholds in config.
  - **An Owner's password reset clears a lock**: lock an account, `PATCH /users/:id/password`
    as an Owner, log in immediately with the new password. (Needs the Owner-seeding the
    `roles.e2e-spec.ts`/`users.e2e-spec.ts` harnesses already do.)
  - **The throttle returns the documented shape**: with the login limit set low in the e2e
    environment, the over-limit request returns `429`, a body matching
    `{ statusCode, message, error }`, and a `Retry-After` header. The body assertion is
    specifically what catches the `ThrottlerException.getResponse()`-is-a-string problem
    from §1 — a test that only asserts the status code passes with the broken shape.
  - **A throttled login never reaches password verification** — assert that an over-limit
    request with the *correct* password still returns `429`, not `200`. This pins the guard
    ordering: a throttler registered after `JwtAuthGuard`, or as route middleware running
    too late, would let it through.
  - **A locked account's existing token still works** (BR-081, the deliberate difference
    from BR-077): capture a token, lock the account by failing on `/auth/login` from
    another request, then use the captured token on `GET /auth/me` and assert `200`. This
    is the non-change test — the analogue of Phase 7's "a transaction response has no
    `updatedAt`" — and it would fail loudly if someone "completed the set" by adding a lock
    check to `JwtStrategy.validate`.
  - If the email-casing fix ships (§1's scope fork): logging in with a differently-cased
    email succeeds.

- **Existing suites — must pass untouched.** The `DEFAULT 0` / nullable columns keep every
  raw `INSERT INTO users (…)` in all five e2e specs compiling, and the e2e environment's
  raised throttle limits keep their rapid-fire request sequences from tripping a `429`.
  That second one is this phase's most likely regression by a wide margin and is why the
  rollout (§6) puts a full-suite run at step 1, before anything else exists.

- **No new integration-layer test** — consistent with Phases 3–7. The one
  concurrency-sensitive spot is the read-then-write counter increment, which §1 accepts as
  a race with a bounded, harmless outcome (an occasional extra guess) rather than
  transaction-wrapping it; a test that pinned the racy behavior would be pinning something
  the design deliberately doesn't guarantee.

---

## 6. Rollout order

1. **`@nestjs/throttler`, `ThrottlerModule`, `AppThrottlerGuard`, and the global guard
   registration — at the generous default limit only.** No auth-route overrides, no
   columns, no lock logic. Then **run the full suite with zero test changes.** If anything
   goes red here, the default limit or the e2e environment's configuration is wrong, and
   finding that out before any behavior depends on it costs nothing. This is the step that
   de-risks the whole phase.
2. **Migration + the two `User` columns.** Nothing reads them yet; the full suite should
   stay green for the same `DEFAULT`-driven reason it did in Phases 6 and 7.
3. **`UsersService.registerFailedLogin` / `clearLoginFailures`, `setPassword` clearing the
   lock, and `AuthService.validateUser`'s new ordering — with their unit tests.** First
   real behavior change. From a client's point of view a fresh database is unaffected
   (nobody is locked), but this is where the feature becomes true.
4. **The tight `@Throttle()` overrides on the two auth routes + the `429` body shape +
   `auth.e2e-spec.ts`.** **This is the feature landing** — the first step that changes an
   existing route's observable behavior for a well-behaved client.
5. **Frontend** (§3): the `429` comment, and the optional Locked badge with its
   Owner-only `locked` boolean. Skippable as a unit if the owner chose backend-only.
6. **Documentation** (§4) — the BR-079–081 entries and the learning note are the
   deliverables that outlast the code, so they are not optional even in the backend-only
   cut.

Steps 1–3 are individually shippable and are no-ops from any well-behaved client's point
of view — the same property Phases 5, 6, and 7 all arranged for, for the same reason: if
step 4 goes wrong, everything before it can stay.

---

## 7. Explicitly out of scope for Phase 8 (Future)

- **An audit log of authentication attempts** — the other half of Phase 5 §7's deferral
  ("audit log of denied attempts"). Who tried, when, from what address, and a screen to
  read it on, is a table and a feature; two counter columns are not the start of one. It
  also overlaps heavily with the administrative audit log Phase 6 §7 and Phase 7 §7 both
  scoped as a separate phase, and the two should probably be designed together when either
  is built.
- **CAPTCHA, 2FA/MFA, WebAuthn, or any second factor** — a materially larger feature with
  its own enrollment flow, recovery story, and UI, none of which a 1–10 person business has
  asked for. A lock and a throttle are the proportionate controls at this scale.
- **A shared throttle store (Redis or Postgres-backed)** — the in-memory default is correct
  for a single process and wrong for several. Recorded in
  `architecture-observations.md` as a named precondition for scaling out (§4), not solved
  here, on the same grounds Phase 7 refused to make the schema-wide `timestamptz` change as
  a side effect of adding two columns.
- **"Someone tried to sign in to your account" notifications** — there is no mail transport
  in this project (BR-078) and this phase does not add one, exactly as Phase 6 did not.
- **A permanent lock, an Owner "unlock" route, or an admin-set per-account policy** — §1;
  the reset is the unlock, and permanence has an unrecoverable state.
- **Exponential or progressive backoff**, per-account adaptive thresholds, or reputation
  scoring — more state and more explanation than a flat window buys at this scale.
- **IP allow/deny lists, geo-blocking, or bot detection** — a different category of
  control, none of it asked for.
- **Password policy changes** — complexity rules, breach-list checks, rotation, and
  expiry all remain out, unchanged from Phase 6 §1's "a floor, not a policy." This phase
  makes guessing expensive; it does not re-litigate what a password may be.
- **Throttling tuned per route beyond the global default and the two auth routes** — the
  backstop exists so that no route is unprotected, not so that every route gets a policy.
- **Locking or throttling on the basis of role** — an Owner's account is not more
  protected than a Staff account. Both are one password away from the same data (BR-073),
  and a role-dependent security control would be a policy with no rule behind it.
- **Q-6, adjustment approval workflow** — still open, still untouched, still not resolved
  by anything here, exactly as Phases 5, 6, and 7 each recorded.
- **The `timestamptz` schema-wide question** (Phase 7 §7) — still parked. `locked_until` is
  a plain `TIMESTAMP` precisely so it doesn't start a second convention (§1).

---

## 8. Definition of done

- [x] `users` has `failed_login_attempts INTEGER NOT NULL DEFAULT 0` and a nullable
      `locked_until TIMESTAMP`, added in one migration with no backfill or
      add-then-constrain step, and every one of the five existing e2e specs' raw
      `INSERT`s still compiles and passes untouched.
- [x] `POST /auth/login` and `PATCH /auth/password` are rate-limited per client address;
      an over-limit request returns `429` with a `Retry-After` header and the same
      `{ statusCode, message, error }` body shape as every other error in `api.md` —
      asserted, not assumed.
- [x] An over-limit login with the **correct** password still returns `429`, proving the
      throttler runs ahead of `JwtAuthGuard` and of password verification.
- [x] N consecutive failures lock an account for T minutes; the lock **expires on its
      own** (proven by an e2e test against a shortened window, not merely by the column
      being set); a successful login clears the counter; and a failure during a lock does
      **not** extend it.
- [x] The lock message is returned **only** after the supplied password has matched; a
      wrong password against a locked account returns the same generic `401` as an unknown
      email — with a test pinning that ordering, so a later "simplification" can't reopen
      Phase 3's enumeration hole.
- [x] An Owner's `PATCH /users/:id/password` clears a lock; there is no separate unlock
      route and no permanent lock state.
- [x] A locked account's existing unexpired token **still works** — `JwtStrategy.validate`
      is unchanged, and a test asserts it, keeping BR-081 distinct from BR-077.
- [x] `PATCH /auth/password` is throttled and deliberately has **no** lockout.
- [x] Thresholds and limits come from `configuration.ts`/`.env.example`, not constants,
      and the e2e environment sets its own so the existing suites pass untouched.
- [x] No new FR, DTO, route, or role rule was added; `failedLoginAttempts` and
      `lockedUntil` appear in no response body (any Owner-visible "locked" indicator is an
      explicit boolean on the already-Owner-only user read, not an un-excluded column).
- [x] `business-rules.md` (BR-079–081, with BR-078 cross-referenced), `api.md` (Phase 8,
      `429` documented), `requirements.md` (the no-FR note), `architecture-observations.md`
      (the in-memory-throttle-vs-multi-instance caveat), `README.md`, `.env.example`, and
      the authentication learning note all reflect this phase — and Q-6 is still recorded
      as open.
- [x] The two scope forks were decided and recorded either way: the email-normalization
      fix in `AuthService.validateUser` (§1) shipped with a test or is written down as a
      known defect, and the frontend half (§3) either shipped or was explicitly cut.
- [x] Full backend suite green: unit, integration, and all five e2e specs.
