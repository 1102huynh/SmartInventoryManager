# Cross-Cutting Concerns — Where Should This Code Live?

*Phase 9's first new learning-note file since Phases 5, 6, and 8 each deliberately
chose to *extend* `authentication-and-guards.md` instead — the addition here is
itself a judgement call, recorded as one rather than slipped in silently. This
subject (a NestJS-shaped comparison of three ways to intercept "something
happened") doesn't belong under "authentication and guards," and it generalizes past
the one feature that prompted it.*

## Concept

A **cross-cutting concern** is behavior that needs to happen alongside many
different operations, without belonging to the business logic of any one of them —
logging, metrics, and (Phase 9's case) an audit trail are the classic examples.
NestJS, like most frameworks with a request pipeline, offers more than one place to
hook such behavior in: a global **Interceptor**, an ORM-level **entity subscriber**,
or an **explicit call** from the code that already does the thing. Which one is
right depends less on which is more "automatic" and more on a single question: *does
the mechanism actually have access to what it needs to say something meaningful?*

## Why this comparison, and not just "use an interceptor"

Phase 9 needed to record *who did what, to what, and when* for a closed list of
authentication and administrative events (`docs/phase-9-plan.md` §1). Three
mechanisms could have written those rows, and the reasoning for rejecting the first
two is the actual lesson here — not a preference, a set of concrete failures.

### Option 1: a global interceptor

An `Interceptor` (`NestInterceptor`) wraps every request; it sees the HTTP method,
the route, and the request/response bodies. That sounds like exactly the right shape
for "log every mutating request" — until you ask what it would actually *write*.

It sees `PATCH /users/7 { role: "owner" }` and the `200` that came back. It does
**not** see what `role` was *before* the patch — that lived inside
`UsersService.update`, in a variable the interceptor never touches. To write
`"Role changed from staff to owner"` (the kind of summary this table exists to
carry, `docs/phase-9-plan.md` §1 "summary is a short human sentence, not a
before/after diff"), the interceptor would have to re-derive the change it never saw
the before-state of — which means re-implementing the read the service already did,
in a second place, for a second reason. It also can't distinguish a failed login
from a wrong `currentPassword` from a plain `403`: all it has is a status code and a
route, not the *meaning* the service already knows.

There's a second problem, orthogonal to the first: an interceptor sees **every**
mutating request by construction. Phase 9's closed list (§1) deliberately excludes
stock movements, reads, and `429` rejections — an interceptor-based design would
have to reimplement that list as a *deny*-list inside the interceptor, which is the
same list written backwards, and easier to get wrong (a route added later is
captured by default instead of excluded by default).

### Option 2: a TypeORM entity subscriber

`@EventSubscriber()` with `afterInsert`/`afterUpdate` hooks fires whenever an entity
is written, entirely inside the ORM layer — closer to the data than an interceptor,
so it *does* see the row's actual before/after values via `updateEvent.databaseEntity`.
It fails for a sharper reason: **it has no access to the request's authenticated
user.** `actor_user_id` is the entire point of this table (§1 "the actor is not the
subject"), and a subscriber has no route to it without smuggling in request-scoped
context — `AsyncLocalStorage`, or making the affected providers `REQUEST`-scoped,
which is a real performance and testability cost in Nest, not a free upgrade.

It also fires on writes that were never meant to be visible. `UsersService`'s
`persistLoginState` (a failed-login counter increment) uses `repository.update()`
specifically so it does **not** look like an edit — Phase 7's whole
`created_at`/`updated_at` convention depends on that write being invisible to
anything that treats "the row changed" as "someone edited this account." A
subscriber firing on every such write would produce a second, redundant audit row
for every failed-counter increment on top of the `login_failed` row already written
deliberately — restating a decision (Phase 8's) that had already been made
correctly elsewhere, and getting it wrong in the restating.

### Option 3: explicit calls from the services that already know

`AuditService.record()`, called directly from `AuthService.validateUser`,
`UsersService.create`/`update`/`setStatus`/`setPassword`/`changeOwnPassword`/
`registerFailedLogin`, and the equivalent write methods on `ProductsService`,
`SuppliersService`, and `CategoriesService`. More lines of code than either
alternative — but every line says what it means, sitting right next to the business
logic whose outcome it describes, with the actor already in scope (threaded in via
`@CurrentUserId()`, the same decorator `InventoryController` already used for FR-061
attribution) and the before/after state already in hand (the service just read it to
decide whether anything changed at all). The closed list from §1 is enforced by the
simple fact that only the listed call sites exist — there's no separate deny-list to
keep in sync, because the list *is* the set of `record()` calls.

## The general rule

**The most automatic mechanism is the one that knows the least about what
happened.** An interceptor sees a request/response pair; a subscriber sees a
database row change; only the code that performed the action knows *why* — what
changed, on whose authority, and whether it's the kind of change this table is even
supposed to know about. Automaticity and semantic richness trade off directly here:
the more of the call sites a mechanism can cover without being told about each one
individually, the less it can say about any single one of them. Choosing the
"automatic" option looks like less work at the point of adoption and produces a
worse table forever after; the explicit option costs more lines once, at every call
site, in exchange for every one of those lines being trustworthy.

This is the same trade this project made once before, from the opposite direction:
`docs/learning-notes/authentication-and-guards.md`'s global-guard-order section
generalizes *for* the automatic mechanism (`APP_GUARD`, registered once) *because*
authentication and role-checking genuinely are the same check on every route — there
is nothing route-specific for the guard to need to know. An audit trail is the
mirror case: the "what happened" is different at every call site by definition, so
the mechanism that needs no per-site information is disqualified before efficiency
or elegance even enter the comparison.

## Example

`AuditModule` deliberately does **not** import `UsersModule` — `AuditService.record()`
takes `actorUserId`/`subjectUserId` as plain `number | null`, never `User` entities,
specifically so recording an event never requires the module that would create a
`UsersModule → AuditModule → UsersModule` cycle. This is a second, smaller instance
of "know only what you need to do the job" — the entity is heavier context than an
id, and the service genuinely doesn't need it. See
`docs/learning-notes/authentication-and-guards.md` "Where password hashing belongs"
for the same shape of module-cycle reasoning, applied there to a stateless password
function instead of an id.

## Common Mistakes

- Reaching for a global interceptor for any "log this" requirement, on the
  assumption that "runs everywhere automatically" is strictly better than "called
  explicitly" — it only is when every call site needs the *same* thing recorded the
  *same* way. An audit trail whose whole value is a human-readable, per-event
  summary is the opposite of that.
- Assuming an ORM-level hook has request context because it "runs during the
  request" — a subscriber runs inside the ORM's event lifecycle, which has no
  built-in channel back to `request.user` without deliberately wiring one (and that
  wiring has its own real costs, not a free win).
- Treating "closed list of events" as something to enforce with a second piece of
  code (a deny-list, an allow-list checked at write time) instead of as a structural
  property of *which functions call `record()` at all* — the second version is one
  fact, is greppable and can't drift.

## Key Takeaways

- Three real options for a cross-cutting concern in Nest — a global interceptor, an
  ORM entity subscriber, an explicit service call — and the right one depends on
  what the mechanism can actually *know*, not on how automatic it looks.
- An interceptor sees the request/response shape, not the business meaning of what
  changed — fine for uniform behavior (logging every request the same way), wrong
  for anything that needs to say *what* happened in the words a person would use.
- An entity subscriber sees the row, not who's calling — request-scoped context
  (the authenticated actor) isn't available there without real infrastructure cost.
- An explicit call costs more lines but each one is trustworthy: the actor and the
  before/after state are both already in scope at the one place that knows what
  actually happened.
- A closed list of recorded events is best enforced by the simple existence of the
  call sites, not a second list (deny- or allow-) that has to be kept in sync with
  the first by hand.
