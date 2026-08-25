# Phase 9 Plan — Audit Log

Status: Phase 9 — Complete
Last updated: 2026-08-25
Scope decided with the project owner: **one append-only `audit_events` table recording who
did what and when — both the authentication half and the administrative half — plus one
Owner-only screen to read it** — and nothing else. Scoped the same way `phase-3-plan.md`
was scoped to authentication, `phase-5-plan.md` to authorization, `phase-6-plan.md` to
user management, `phase-7-plan.md` to audit timestamps, and `phase-8-plan.md` to rate
limiting and lockout: one headline change, an explicit out-of-scope list, no punch-list
riding along.

## Why this phase, why now

This is the only remaining item deferred **by name** in *four consecutive phases*. Phase 5
§7 named the first half:

> **Rate limiting, audit log of denied attempts, account lockout** — adjacent security
> work, none of it asked for, none of it required by the two-role split.

Phase 6 §7 and Phase 7 §7 each named the second half — "the administrative audit log" —
and scoped it as a phase of its own. Phase 8 §7 came back to both and left this phase an
explicit instruction:

> **An audit log of authentication attempts** — the other half of Phase 5 §7's deferral
> ("audit log of denied attempts"). Who tried, when, from what address, and a screen to
> read it on, is a table and a feature; two counter columns are not the start of one. It
> also overlaps heavily with the administrative audit log Phase 6 §7 and Phase 7 §7 both
> scoped as a separate phase, **and the two should probably be designed together when
> either is built.**

This is that phase, designed together as instructed. As with Phase 8, nothing about the
system changed to make this newly necessary — what changed is that the deferral reasoning
ran out. But two things do make *now* the right time rather than later:

- **Phase 6 made accounts mutable by a person instead of by `psql`.** Before it, "who
  changed Riley's role?" had exactly one answer — whoever had database access, which in a
  1–10 person business is one specific human. After it, an Owner creates accounts, edits
  names and emails, promotes and demotes roles, deactivates people, and resets passwords,
  all through a UI, and BR-075 only guarantees that *at least one* active Owner exists,
  not that there is only one. The question became answerable-in-principle and
  unanswerable-in-practice at the same moment.
- **Phase 8 introduced a state that a stranger can put an account into.** The `locked`
  badge Phase 8 shipped on the Users screen tells an Owner *that* an account is locked. It
  cannot tell them whether that was Riley fat-fingering `password123` at the counter or
  someone working through an email list from another continent — and those two situations
  call for opposite responses (reset the password vs. do not reset the password, look at
  the log). **Phase 8 shipped the question; this phase is the answer.** That is the
  strongest single argument for building it now rather than in a phase or two.

One framing makes the whole phase coherent and is worth stating before any decision:
**an audit log answers "who did this, to what, and when" — a question no other record in
this system can answer.** `inventory_transactions` answers it, completely and immutably,
for stock movements and only for stock movements (FR-061, BR-050). Phase 7's `updated_at`
answers "when was this row last edited" but never *who* edited it and never *what
changed*. The gap between those two is precisely: account creation and edits, role
changes, deactivations, password resets, master-data writes, and every authentication
attempt. Naming the gap that precisely is what keeps this table from quietly becoming a
log of everything — §1 spends most of its length on what is deliberately *not* in it.

---

## 1. Design decisions

### One table, one shape, two categories — not two tables

`audit_events`, with an `event_type` enum spanning both halves.

Two tables (`login_attempts` and `admin_actions`) is the obvious-looking alternative, and
Phase 8 §1 already rejected the first of them by name:

> **Not a new `login_attempts` table.** A table of attempt rows is an *audit log of
> authentication attempts* — the other half of what Phase 5 §7 deferred, and a genuinely
> different feature.

That was a refusal to *start* the table in a phase that didn't need it, not an argument
for two tables when the time came. Two tables would mean two screens, two query shapes,
two retention decisions, and — decisively — an Owner who has to know which one to open to
answer a question whose answer spans both. "What happened to Riley's account last
Tuesday?" is one narrative: *locked out three times in an hour, then an Owner reset the
password, then a successful login.* Half of that is authentication and half of it is
administration, and splitting the storage splits the story. One table with an
`event_type` filter is one screen and one narrative.

The cost of the single table is that its columns must be general enough to fit both kinds
of event, which is what the next two decisions are about.

### The actor is not the subject — two nullable columns, and this is the sharpest line in the phase

`actor_user_id` means **the authenticated principal who performed this action**.
`subject_user_id` means **the account this event is about**. Both are nullable FKs to
`users`. They are not the same column and must never be merged.

The forcing case is a failed login, and it is worth walking through slowly because the
intuitive implementation is wrong in a way that would poison the whole table:

- A **failed login for an unknown email** has no actor row at all and no subject row
  either. Nobody typed a valid identity; there is nothing in `users` to point at. Both
  columns are `NULL`, and the only evidence the row carries is the type, the time, and
  (see the scope fork below) the address.
- A **failed login for a known email** does have a matching `users` row — and recording
  that row as `actor_user_id` would be a **lie**. The person who typed the wrong password
  is, in the case this table exists for, precisely *not* that user. An audit log whose
  actor column sometimes means "the person who did this" and sometimes means "the person
  someone was pretending to be" is worse than no audit log, because an Owner would read it
  as the former in both cases.

So: a failed login records `actor = NULL, subject = <the user, if the email matched one>`.
An Owner deactivating Riley records `actor = Alex, subject = Riley`. An Owner creating a
product records `actor = Alex, subject = NULL`. A user changing their own password records
`actor = subject = themselves` — the one case where they legitimately coincide, and it
coincides because the fact really is symmetric, not because the columns were collapsed.

This split is also what lets *one* screen answer both of an Owner's real questions —
"what has Alex been doing" (filter on actor) and "what has been happening to Riley's
account" (filter on subject) — without a second table or a second endpoint. Both filters
are in the query DTO for exactly this reason (§2).

`actor_user_id` and `subject_user_id` are real foreign keys with `ON DELETE RESTRICT`, and
that is safe **because of BR-076**: users are deactivated, never deleted, so a `users` row
can never disappear out from under an audit row. That is not a coincidence — it is the
same guarantee that already makes `inventory_transactions.recorded_by_user_id` a
`RESTRICT` FK worth having (BR-076's own reasoning: "attribution would be worthless if the
row it points at could vanish"). The audit log inherits that property for free. Contrast
this deliberately with `entity_id`, below, which gets the opposite treatment for the
opposite reason.

### The target of an administrative event is `entity_type` + `entity_id`, and it is deliberately *not* a foreign key

An administrative event about a product, supplier, or category records `entity_type`
(a small enum: `product`, `supplier`, `category`, `user`) and `entity_id` (a plain nullable
integer). Both `NULL` for events that have no target beyond the subject user.

`entity_id` gets **no foreign key**, and that is a decision, not an omission. A
`product_deleted` event points at an id that no longer exists — that is the *entire point*
of recording it. A foreign key would leave only two possible behaviors, and both are
wrong:

- `RESTRICT` would make the audit row *forbid the delete*, turning BR-004's carefully
  scoped "a product with no transaction history may be deleted" into a lie the first time
  anyone deletes one.
- `CASCADE` would delete the audit row along with the product — an audit log that erases
  the record of a deletion when the deletion happens, which is the single thing an audit
  log must never do.

So the column is un-joinable by the database on purpose. The frontend renders the entity
name from the event's `summary` text (below), not from a join, and a link to a deleted
product's detail page simply 404s — which is honest.

Two id columns, opposite treatments, one specific reason each: `users` rows can't vanish
(BR-076), so a real FK; `products`/`categories` rows can (BR-004, and
`CategoriesService.remove`'s real delete), so no FK.

### `summary` is a short human sentence, not a before/after diff

Each event carries a `summary` — a short `text`, written by the service that records the
event, in the words a person would use: `"Role changed from staff to owner"`,
`"Deactivated"`, `"Password reset by an Owner"`, `"Locked for 15 minutes after 5
consecutive failures"`.

The tempting alternative is a `JSONB` payload holding the changed fields' before and after
values. Rejected on three grounds, in increasing order of importance:

1. **Nobody asks for a changeset.** An Owner reading this screen wants a sentence. The
   field-level diff is a general-purpose mechanism, and this product has no
   general-purpose need for one — the same reasoning `phase-5-plan.md` §1 used to refuse a
   per-permission table in favor of two roles.
2. **A diff has to be maintained on every entity, forever.** Every new column on every
   audited entity is a new decision about whether it belongs in the payload, made by
   whoever adds the column, possibly years later, possibly not at all.
3. **A diff is a place where a value can be reconstructed after the row it came from was
   legitimately changed.** That is fine for a product's name and catastrophic for a
   password hash or, less obviously, an email address. The rule "never put a credential in
   the summary" is one sentence to write and one thing to check at a handful of call
   sites; the rule "never put a credential in the diff" is an allow-list that has to stay
   correct on every entity for the life of the project. A hand-written summary cannot leak
   what it never contains.

The concrete discipline this implies, and it belongs in the code as a comment on
`AuditService.record`: **a summary never contains a password, a password hash, or a token
— not before, not after, not "redacted".** `user_password_reset` records *that* a reset
happened, never anything about either password.

### What is recorded — a closed list, and the exclusions matter more than the inclusions

`AuditEventType`, in full:

| Event | Actor | Subject | Entity |
|---|---|---|---|
| `login_succeeded` | NULL | the user | — |
| `login_failed` | NULL | the user, or NULL for an unknown email | — |
| `account_locked` | NULL | the user | — |
| `password_changed` | the user | the same user | — |
| `user_created` | the Owner | the new user | `user` |
| `user_updated` | the Owner | the edited user | `user` |
| `user_status_changed` | the Owner | the affected user | `user` |
| `user_password_reset` | the Owner | the affected user | `user` |
| `product_created` / `product_updated` / `product_status_changed` / `product_deleted` | the Owner | NULL | `product` |
| `supplier_created` / `supplier_updated` / `supplier_status_changed` | the Owner | NULL | `supplier` |
| `category_created` / `category_updated` / `category_deleted` | the Owner | NULL | `category` |

**Deliberately not recorded, each for its own reason:**

- **Reads. Every single GET.** A read log is a different feature with two orders of
  magnitude more volume and no question behind it that the Owner of a 1–10 person business
  actually asks. "Who looked at the product list" is not a thing anyone here needs to know.
- **Stock-in, stock-out, and adjustments.** This is the most important exclusion in the
  phase. `inventory_transactions` already records who did it, when, why, and against what,
  immutably (BR-050, BR-051), with two screens to read it on (FR-030, FR-031). Copying
  those rows into `audit_events` would create two records of one fact that can drift apart
  — and, worse, would bury the handful of administrative events this table exists for
  under the ordinary daily traffic the product is *for*. A busy week is dozens of stock
  movements and zero role changes; an audit log in which the role change is on page four
  has failed at its job. **The audit log records what happens *to* the system; the
  transaction log records what happens *in* it.** That sentence is the whole exclusion, and
  it is also what keeps the table small enough to read without pagination (§ below).
- **`429` throttle rejections.** Named explicitly because "log the rate-limit hits too" is
  the intuitive-looking, wrong answer — the same shape of mistake as Phase 8 §1's "reset
  the timer on every failure." Three reasons: they are per-address, not per-account, so
  they have no subject to attach to; they arrive by the hundred in exactly the case that
  matters; and Phase 8's entire design puts the throttler guard *first* precisely so a
  flood costs nothing before it is rejected. Writing a database row per rejected request
  would hand an attacker a way to make the server do work on demand — converting a defense
  into an amplifier. The throttle's counters stay in the throttler's own in-memory store,
  where `architecture-observations.md` already documents them.

**One inclusion worth defending: `password_changed`** (the self-service `PATCH
/auth/password`). There is a real argument against it — the account holder acting on
their own account, already authenticated, is nobody else's business, and it is the one
event in the table an Owner has no authority over. It is included anyway, because
"someone changed my password and it wasn't me" is exactly the incident an audit log exists
for, and because its absence would make this table's answer to "what happened to my
account" quietly incomplete in the one case where completeness matters most. The tension
is real and is recorded here rather than smoothed over.

### Recording is best-effort and never fails the request it describes

`AuditService.record()` catches its own errors and logs them through Nest's `Logger`; it
never rethrows. An Owner must not be unable to deactivate a compromised account because
the audit table is full, or because a constraint changed under a deploy.

The cost has to be said out loud rather than left implied: **this means the log can
silently miss an event, so it is a *record*, not a *proof*.** `business-rules.md` should
say that in the rule itself (BR-082, §4) instead of implying legal-grade completeness that
the implementation does not provide. A 1–10 person business wanting evidence for a dispute
needs a different product; this one is answering "what happened to my account last
Tuesday" for a person who mostly trusts their colleagues.

**And the counter-decision: the audit write is *not* wrapped in a transaction with the
operation it describes.** Making the two atomic would be nicer, and it is what a larger
system should do. It is refused here because the write paths involved — `UsersService`,
`ProductsService`, `SuppliersService`, `CategoriesService` — do not use transactions at
all today. Only `InventoryService` does (`docs/learning-notes/database-transactions.md`),
and `InventoryService` is the one service this phase deliberately does not touch (§ above).
Introducing a transaction wrapper across four services to protect a log that has already
been declared best-effort would be a substantially larger and riskier change than the log
itself — the same shape of acceptance Phase 8 §1 made for the read-then-write failure
counter, and Phase 6 §5 for `assertOwnerRemains`.

### The write is an explicit service call — not an interceptor, not an entity subscriber

Three mechanisms could record these events, and the choice is the most NestJS-shaped
decision in the phase:

- **A global interceptor** that logs every mutating request. Rejected: it sees the HTTP
  method, the route, and the body, but not the *meaning*. It cannot write "Role changed
  from staff to owner" without re-deriving the change it never saw the before-state of,
  and it cannot distinguish a failed login from a wrong `currentPassword` from a `403`.
  It would also log everything by construction, which §4's closed list explicitly refuses
  — the list would have to be reimplemented as a deny-list inside the interceptor, which
  is the same list written backwards and easier to get wrong.
- **A TypeORM entity subscriber** (`afterInsert` / `afterUpdate`). Rejected for a sharper
  reason: **a subscriber has no access to the request's authenticated user.**
  `actor_user_id` is the entire point of this table, and a subscriber cannot supply it
  without request-scoped context (`AsyncLocalStorage`, or `REQUEST`-scoped providers that
  would make four services request-scoped — a real performance and testability change in
  Nest, not a free one). It would also fire on `UsersService.persistLoginState`, the one
  write Phase 8 went out of its way to make invisible, producing an audit row for every
  failed-counter increment on top of the `login_failed` row we already write deliberately.
- **Explicit calls from the services that already know what happened.** Chosen. More
  lines of code, but every line says what it means, the closed list in §4 is enforced by
  the simple fact that only listed call sites exist, and each call sits next to the
  business logic whose outcome it describes. This is the `assertOwnerRemains` pattern
  again: one helper, called from every path that touches the thing, so the paths cannot
  drift.

`AuditModule` provides and exports `AuditService`; `AuthModule`, `UsersModule`,
`ProductsModule`, `SuppliersModule`, and `CategoriesModule` import it.

**One import-direction constraint that must be respected**: `AuditModule` must **not**
import `UsersModule`. `AuditService.record()` takes actor and subject as plain `number |
null` ids, never `User` entities. Taking entities would pull `UsersModule` in and create
`UsersModule → AuditModule → UsersModule`, a cycle Nest can only be talked out of with
`forwardRef()` — machinery this app has so far avoided entirely. Recording by id keeps the
dependency graph a DAG for free, and costs nothing: the id is all the column stores.

### Threading the actor: `@CurrentUserId()`, and this is the phase's real mechanical cost

The services that perform administrative writes do not currently know who is calling them.
`UsersService.setStatus(id, status)`, `ProductsService.create(dto)`,
`CategoriesService.remove(id)` and their siblings take no actor.

There is exactly one existing, established way to fix that, and it is already in the
codebase: **`@CurrentUserId()`**, used by `InventoryController` for FR-061 attribution and
by `AuthController` for `PATCH /auth/password`. The four administrative controllers gain
an `@CurrentUserId() actorId: number` parameter on each write route and pass it through.
`InventoryService.recordStockIn(productId, dto, userId)` is the exact precedent for the
resulting service signature.

**This is a signature change on roughly a dozen service methods and their unit tests, and
it is the single largest mechanical cost of this phase — worth naming plainly rather than
discovering in step 4.** The alternative (a request-scoped provider or `AsyncLocalStorage`
that makes the actor ambiently available) would avoid the churn and hide the dependency:
it becomes impossible to tell from a service's signature whether it records anything, and
every affected provider changes scope. An explicit parameter is boring, greppable, and
unit-testable, and it is the choice this codebase already made once. §6 isolates the churn
into its own rollout step for exactly this reason.

It is also worth noting what this phase does *not* have, in contrast to its three
predecessors: **there is no `DEFAULT` that keeps the existing tests untouched.** Phases 6,
7, and 8 each got that property for free from a column default (`'active'`, `now()`, `0`),
and each plan said so. This phase's changes are to method signatures, not to columns, so
the existing unit specs for the four affected services *will* need updating. §5 says which
and §6 puts them in one step.

### The read is Owner-only — and the argument is one step sharper than BR-074's

`GET /audit-events` sits on an `AuditController` carrying a **class-level**
`@Roles(UserRole.Owner)` — the second controller in the app to use the class-level form
after `UsersController` (BR-074), for the same structural reason: every route on it is
Owner-only, so there is nothing to put a per-route decorator on.

But the substantive reason is stronger here than it was for the user list. BR-074's
argument was that leaving the user list open to Staff "would make Phase 3's
identical-401-for-unknown-email-vs-wrong-password care pointless from inside the app."
This table contains **failed login attempts against named accounts** — which is not merely
a list of who exists, but a list of who is currently being attacked and which accounts are
close to their lockout threshold. Phase 3 closed enumeration from the outside; Phase 8
closed it again from a second direction (BR-081's ordering rule). Letting Staff read this
screen would reopen it from the inside, with interest. Owner-only, class-level, no
exceptions.

### Newest first, capped, no pagination — and why the cap is not optional here

`GET /audit-events` orders by `id DESC` (a serial primary key is already a perfect
insertion-order proxy, and it is the primary key index, so the ordering is free) and
applies a `LIMIT`: default 100, maximum 500, from the query DTO.

No offset pagination. No screen in this product has ever had it — `GET
/inventory-transactions` returns every matching row — and filters plus a cap are enough
for a business this size. But there is a real difference from the transactions list worth
stating: **the audit table grows without any user doing anything.** Every failed login
anywhere on the internet writes a row. `inventory_transactions` only grows when a
colleague records a movement. A cap on this endpoint is therefore not the stylistic
courtesy it would be on the transactions endpoint; it is the acknowledgement that this
table has an external growth driver, and it is why §7 names retention as a real follow-on
with a concrete trigger rather than a vague "someday."

Two indexes, both cheap insurance rather than a present necessity: `created_at` (the
`days` filter) and `subject_user_id` (the "what happened to this account" query, which is
the phase's headline use case). Not `actor_user_id` — that filter exists but is the rarer
question, and one unused index is one too many on a table whose write path is on the login
hot path.

**The cap is a constant, not configuration** — the deliberate inverse of Phase 8 §1's
"Configuration, not constants." Phase 8's thresholds had two reasons to be configurable: a
deployment might reasonably tune them, and the e2e suite could not otherwise test
auto-expiry. Neither applies here. No deployment tunes a page size, and no test needs to
vary it (a test that wants to prove the cap works sets `limit=2` through the query string,
which is a feature of the endpoint, not of the environment). Recording the inverse
decision with its reason keeps `configuration.ts` from accumulating knobs nobody turns.

### Plain `TIMESTAMP` again — and the deferral is getting more expensive each time

`created_at` is a `@CreateDateColumn` of plain `TIMESTAMP`, matching `domain-model.md` §8
and every other server-set timestamp in this schema. No `updated_at`: this is the **second
instance of the immutable-table rule** that Phase 7 wrote down using
`inventory_transactions` as its worked example. Having a second instance is itself a small
piece of evidence that the rule was worth writing as a rule.

But the `timestamptz` question Phase 7 §7 parked, and Phase 8 §1 declined to reopen, is
now being deferred for a third time — and it is worth noting that each new table makes the
eventual migration one table wider. This phase still does not resolve it, for exactly the
reason both predecessors gave (a schema-wide change should not ride along as a side effect
of adding a table), but `architecture-observations.md` should record that the eventual
migration is now one table wider than when Phase 7 parked it — and, ideally, name the exact
columns, so the next person deciding has a list rather than an impression.

### This phase *does* add an FR — the honest inverse of Phases 7 and 8

Phases 7 and 8 both added no functional requirement and recorded the absence with its
reason: an audit column and a rate limiter are not user goals. The discipline there was
"record what's true," not "always say no FR" — and here the truth points the other way.

**An Owner opens a screen and reads it to do a job.** That is a capability, with a route,
a UI, and a person's question behind it. So this phase adds:

- **FR-065 — View audit log** (Should), with the same "operability, not MVP correctness"
  reasoning FR-063 and FR-064 carry.
- **A `product.md` §4 user goal**: *"Know who changed what, and when — for accounts and
  catalog data, not just stock."* §4's existing "Trust that historical records are accurate
  and cannot be silently altered" is about inventory history specifically; nothing there
  covers account or catalog changes.
- **A `product.md` §5 use case**: *"An Owner reviews the audit log after a colleague
  reports they cannot sign in."*

Adding a user goal to `product.md` §4 is a genuine product-scope change and this plan
flags it as such: it is Phase 9's one product-level edit, deliberate and recorded, not a
documentation tidy-up. It resolves none of the open questions — **Q-4, Q-6, and Q-7 remain
exactly as open as they were**, and Q-6 in particular is *not* resolved by this phase even
though an audit log superficially looks adjacent to an approval workflow. A log records
what happened; an approval gates what may happen. Different features.

### Two flagged scope forks

Every plan in this series has one or two, decided explicitly rather than drifted into.

**Fork A — capturing the client address on authentication events. Recommended: include.**
Phase 5 §7's original wording was "who tried, **from where**, when," and Phase 8 §7 kept
that wording. Without an address, a `login_failed` row cannot distinguish Riley fumbling at
the counter from a script working through an email list — which is *the* question the
Phase 8 `locked` badge raises and this phase exists to answer. That is a large fraction of
the auth half's value for one nullable column (`actor_ip`, a `varchar(45)` sized for IPv6,
NULL for every administrative event) and one small `@ClientIp()` param decorator alongside
the existing `@CurrentUserId()`.

Three costs, all real and none disqualifying:
- **`req.ip` is only honest without a proxy.** Phase 8 already documented this in
  `.env.example` and the README for the throttle. Including this column promotes that from
  a throttling caveat to a *correctness* caveat for the log — behind an unconfigured
  proxy, every row would record the proxy's address, which is worse than recording nothing
  because it looks like data. The existing warning needs one sentence added, not a new one
  written.
- **It puts personal data in the table.** An IP address is personal data in most
  jurisdictions, in a table with no retention policy (§7). A 1–10 person business should
  be told this exists rather than discovering it, which is one line in the README and one
  in BR-082.
- **The throttler guard runs first and has no `request.user`** — but `@ClientIp()` reads
  `req.ip`, which Express populates before any guard, so unlike Phase 8's noted
  limitation this one does not bite.

**Fork B — the frontend screen. Recommended: include, and unlike Phase 8, cutting it is
not a coherent stopping point.** Phase 8 §3 offered a backend-only cut because everything
in its frontend section was either a no-op confirmation or an optional badge. Here the
inverse holds: without `#/audit`, this phase produces a table that is written on every
login and read by nobody, since the only consumer is an HTTP endpoint no part of the
product calls. The backend-only cut would be a phase whose entire value is deferred to an
unscheduled follow-on — which is exactly the shape these plans reject. If the owner wants
a smaller Phase 9, the better cut is by *event category* (ship the authentication half and
its screen, defer the administrative half and its dozen signature changes to Phase 10),
not by layer. That cut is coherent; a backend-only cut is not.

---

## 2. What's new (backend)

### No new dependency

Everything here is TypeORM, `class-validator`, and Nest primitives the app already uses.
Worth noting because Phase 8 needed `@nestjs/throttler` and this one does not — an audit
log is domain code, not infrastructure.

### `common/enums/audit-event-type.enum.ts` and `audit-entity-type.enum.ts`

```ts
// The closed list from §1. Snake_case values matching the wire format
// TransactionType and UserRole already use.
export enum AuditEventType {
  LOGIN_SUCCEEDED = 'login_succeeded',
  LOGIN_FAILED = 'login_failed',
  ACCOUNT_LOCKED = 'account_locked',
  PASSWORD_CHANGED = 'password_changed',
  USER_CREATED = 'user_created',
  USER_UPDATED = 'user_updated',
  USER_STATUS_CHANGED = 'user_status_changed',
  USER_PASSWORD_RESET = 'user_password_reset',
  PRODUCT_CREATED = 'product_created',
  PRODUCT_UPDATED = 'product_updated',
  PRODUCT_STATUS_CHANGED = 'product_status_changed',
  PRODUCT_DELETED = 'product_deleted',
  SUPPLIER_CREATED = 'supplier_created',
  SUPPLIER_UPDATED = 'supplier_updated',
  SUPPLIER_STATUS_CHANGED = 'supplier_status_changed',
  CATEGORY_CREATED = 'category_created',
  CATEGORY_UPDATED = 'category_updated',
  CATEGORY_DELETED = 'category_deleted',
}

export enum AuditEntityType {
  USER = 'user',
  PRODUCT = 'product',
  SUPPLIER = 'supplier',
  CATEGORY = 'category',
}
```

Both live in `common/enums/` beside `transaction-type.enum.ts`, `user-role.enum.ts`, and
`entity-status.enum.ts`, because both are referenced from more than one module.

### `audit/audit-event.entity.ts`

Modeled directly on `InventoryTransaction`, the app's existing append-only entity — same
`@CreateDateColumn`, same absence of an `@UpdateDateColumn`, and the same style of comment
saying *why* the absence is deliberate.

```ts
@Entity('audit_events')
@Index(['createdAt'])
@Index(['subjectUserId'])
export class AuditEvent {
  @PrimaryGeneratedColumn() id: number;

  @Column({ name: 'event_type', type: 'enum', enum: AuditEventType })
  eventType: AuditEventType;

  // §1 "The actor is not the subject". NULL for every anonymous event — a failed
  // login's actor is unknown BY DEFINITION, and writing the matched user here would
  // claim they typed their own wrong password.
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actor: User | null;
  @Column({ name: 'actor_user_id', type: 'int', nullable: true })
  actorUserId: number | null;

  // The account this event is ABOUT. RESTRICT is safe here only because BR-076
  // guarantees a user row never disappears — contrast entityId below.
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subject_user_id' })
  subject: User | null;
  @Column({ name: 'subject_user_id', type: 'int', nullable: true })
  subjectUserId: number | null;

  @Column({ name: 'entity_type', type: 'enum', enum: AuditEntityType, nullable: true })
  entityType: AuditEntityType | null;

  // Deliberately NOT a foreign key (§1): a product_deleted event points at an id that
  // no longer exists, which is the point. RESTRICT would forbid the delete BR-004
  // permits; CASCADE would erase the record of the deletion as it happened.
  @Column({ name: 'entity_id', type: 'int', nullable: true })
  entityId: number | null;

  // A short human sentence, never a diff, and never a credential (§1).
  @Column({ type: 'text' })
  summary: string;

  // Scope fork A (§1). NULL on every administrative event.
  @Column({ name: 'actor_ip', type: 'varchar', length: 45, nullable: true })
  actorIp: string | null;

  // No @UpdateDateColumn, deliberately — domain-model.md §8's immutable-table rule,
  // second instance after inventory_transactions. Nothing in this app UPDATEs or
  // DELETEs a row in this table; there is no route and no service method that could.
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
```

No `@Check` constraints. `InventoryTransaction` has three, encoding BR-050 in the schema as
a second line of defense — appropriate there, because those rows are written from
user-supplied input through three different code paths. Here every row is composed
entirely by `AuditService` from server-side facts, and the invariants worth checking
("actor is NULL exactly when the event type is anonymous") are ones a `CHECK` would have
to enumerate per event type, which would need a migration every time the enum grows. The
unit tests in §5 pin the same properties at lower cost.

### Migration `1787650000000-AddAuditEvents.ts`

Sorting after `1787560000000-AddLoginLockoutToUsers`. Creates two enum types, one table,
two indexes; `down` drops them in reverse.

```
up:
  CREATE TYPE "audit_events_event_type_enum"  AS ENUM (...18 values...)
  CREATE TYPE "audit_events_entity_type_enum" AS ENUM ('user','product','supplier','category')
  CREATE TABLE "audit_events" (
    "id"              SERIAL PRIMARY KEY,
    "event_type"      "audit_events_event_type_enum"  NOT NULL,
    "actor_user_id"   INTEGER NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "subject_user_id" INTEGER NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "entity_type"     "audit_events_entity_type_enum" NULL,
    "entity_id"       INTEGER NULL,              -- no FK, deliberately (§1)
    "summary"         TEXT NOT NULL,
    "actor_ip"        VARCHAR(45) NULL,
    "created_at"      TIMESTAMP NOT NULL DEFAULT now()
  )
  CREATE INDEX "IDX_audit_events_created_at"      ON "audit_events" ("created_at")
  CREATE INDEX "IDX_audit_events_subject_user_id" ON "audit_events" ("subject_user_id")

down:
  DROP TABLE "audit_events"                       -- takes its indexes with it
  DROP TYPE  "audit_events_entity_type_enum"
  DROP TYPE  "audit_events_event_type_enum"
```

A new table rather than new columns, so unlike Phases 6–8 there is no backfill question at
all and no existing `INSERT` in any e2e spec to keep compiling. The header comment should
say why `entity_id` has no `REFERENCES` clause, since a reader's first instinct on seeing
`entity_id INTEGER NULL` with no FK will be that someone forgot.

### Three entity registries, all three of which must be updated

`AuditEvent` has to be added to the `entities` array in **all three** places that list
them, and missing one fails in a different way each time:

- `database/database.module.ts` — the running app. Missing it: `AuditService`'s
  `@InjectRepository(AuditEvent)` fails at bootstrap, loudly.
- `database/data-source.ts` — the TypeORM CLI. Missing it: `migration:generate` produces
  nonsense, though `migration:run` on a hand-written migration still works, so this one can
  hide.
- `database/test-data-source.ts` — the integration-test database, which uses
  `synchronize: true`. Missing it: the table simply doesn't exist in
  `smart_inventory_test`, and only a test that touches it notices.

Listed explicitly because the third is the one that gets forgotten.

### `audit/audit.module.ts`, `audit.service.ts`, `audit.controller.ts`

```ts
@Module({
  imports: [TypeOrmModule.forFeature([AuditEvent])],  // NOT UsersModule — §1, cycle
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
```

`AuditService` has two halves and they are asymmetric on purpose:

- **`record(event: RecordAuditEvent): Promise<void>`** — one `INSERT`, wrapped in
  `try/catch` that logs and swallows (§1 "best-effort"). Takes plain ids, never entities.
  The `try/catch` gets a comment explaining that swallowing here is the decision, not an
  oversight, and that the consequence is BR-082's "a record, not a proof."
- **`findAll(query: QueryAuditEventsDto): Promise<AuditEvent[]>`** — a query builder in
  the style of `ProductsService.findAll`, with `relations` on `actor` and `subject` so the
  screen renders names without a second request (the same joined-read choice
  `InventoryService.listAll` already made for `product`/`supplier`/`recordedBy`).
  `ORDER BY id DESC`, `LIMIT` from the DTO.

The nested `actor`/`subject` `User` objects are serialized by the same
`ClassSerializerInterceptor` that already strips `passwordHash`, `failedLoginAttempts`, and
`lockedUntil` via `@Exclude()` — so the joined read is safe by construction, and it is safe
for the same reason Phase 8 §2 gave when it excluded the lockout columns. Worth an assertion
in the e2e suite rather than an assumption (§5).

### `audit/dto/query-audit-events.dto.ts`

Mirrors `QueryTransactionsDto` deliberately — same optional-filter shape, same
`class-validator` decorators, so the two query endpoints read the same way:

```ts
export class QueryAuditEventsDto {
  @IsOptional() @IsEnum(AuditEventType)  eventType?: AuditEventType;
  @IsOptional() @Type(() => Number) @IsInt() actorUserId?: number;
  @IsOptional() @Type(() => Number) @IsInt() subjectUserId?: number;
  @IsOptional() @Type(() => Number) @IsInt() days?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;  // default 100
}
```

`@Max(500)` rather than silently clamping in the service: the global `ValidationPipe`
already turns a violated constraint into the documented `400` shape, and a request for
`limit=100000` is a caller misunderstanding the endpoint — better answered than quietly
reinterpreted into something else.

### `common/decorators/client-ip.decorator.ts` (scope fork A)

A four-line `createParamDecorator` returning `request.ip`, sitting beside
`current-user-id.decorator.ts`, with a comment pointing at the `trust proxy` warning that
`.env.example` and the README already carry — and noting that unlike `@CurrentUserId()`,
this one works in a `@Public()` route, which is exactly where it is needed.

### The write call sites

**`AuthService.validateUser`** — three of the four authentication events, threaded into
the ordering Phase 8 established. The existing comment block is *extended*, not rewritten:
it is already the canonical explanation of why the status and lock checks run after the
hash comparison, and the audit calls slot into that same sequence without changing it.

```
user = findByEmail(normalizeEmail(email));
if (!user) { audit(LOGIN_FAILED, subject: null); return null; }     // unknown email
matches = await verifyPassword(...);
if (!matches) {
  await registerFailedLogin(user);                                  // may emit ACCOUNT_LOCKED
  audit(LOGIN_FAILED, subject: user);
  return null;
}
if (user.status === INACTIVE) { audit(LOGIN_FAILED, subject: user); throw Deactivated; }
if (isLocked(user))           { audit(LOGIN_FAILED, subject: user); throw Locked(...); }
await clearLoginFailures(user);
audit(LOGIN_SUCCEEDED, subject: user);
return user;
```

Two details worth stating because they are easy to get wrong:
- A deactivated or locked account's rejection is a **`login_failed`**, not a new event
  type. The credential was right; the outcome was still "did not get in," and an Owner
  reading the log cares about the outcome. The `summary` carries the distinction
  ("Rejected — account deactivated" / "Rejected — account locked").
- **A failed attempt against an already-locked account still writes a `login_failed`
  row**, even though `registerFailedLogin` returns early and changes nothing. That row is
  precisely the evidence an Owner needs — *someone is still hammering* — and it is what
  turns Phase 8's anti-DoS early-return from an invisible non-event into a visible one.
  The row rate is bounded by the throttle, not by the lock: another instance of Phase 8
  §1's "each of the three is load-bearing and none of them does another's job."

**`UsersService.registerFailedLogin`** — emits `ACCOUNT_LOCKED` **once, at the transition**,
inside the branch that sets `lockedUntil`, never on subsequent blocked attempts. This
falls out of Phase 8's existing structure for free: the same early-return that stops an
attacker extending a lock forever also gives this event its natural once-per-lock
semantics. The two decisions reinforce each other and the comment should say so.

**`UsersService`** — `create`, `update`, `setStatus`, `setPassword`, `changeOwnPassword`
each take an `actorId` and record their event. `update` composes its summary from the
fields that actually changed, which the method already knows (it compares each before
assigning). `setPassword`'s summary is `"Password reset by an Owner"` and mentions the
lock clear when one was actually cleared — the one place a Phase 8 lock and a Phase 9
audit row meet.

**`ProductsService` / `SuppliersService` / `CategoriesService`** — same shape, `actorId`
threaded from the controller, one `record` call per write method.

`InventoryService` — **unchanged**. §1's central exclusion.

### No new configuration, no `.env.example` change

The deliberate inverse of Phase 8 (§1). Nothing here is a policy number a deployment would
tune or a test needs to vary.

### `run-seed.ts` — no change, and the audit log is legitimately empty afterward

Phase 8 declined to seed a locked user because a seeded lock would expire mid-demo and
look like a bug. The reason here is different and stronger: **a seeded audit log would be
fiction.** Every row would attribute an action to a person who never performed it, in a
table whose entire value is that its rows are true. `npm run seed` writes users, products,
suppliers, categories, and transactions directly through repositories, so it emits no
audit events, and the audit screen is correctly empty on a fresh database until someone
actually does something. The README should say so in the same spirit as the existing Riley
and lockout notes, so a developer's first reaction to an empty screen is "of course" and
not "broken."

---

## 3. Frontend changes

One new screen, one new nav item, one router entry, one cross-link. Modeled directly on
`Views.historyView`, which is the closest existing analogue — a filtered, read-only,
newest-first table with a toolbar of `<select>`s.

**In scope:**

- **`Views.auditLog(container, query)`** at `#/audit`. Same structure as
  `Views.historyView`: `header()` / `toolbar()` / `body(list)` / `rowHtml(e)`, loaded
  through `UI.mockFetch` with the same skeleton-then-render-or-error pattern, and the same
  `UI.previewControl(override)` for the empty/error states every other list view has.
  Columns: **When · Event · Actor · Subject / Target · Details**. The `summary` is the
  Details column verbatim — §1's whole argument for a hand-written sentence is that it
  renders without interpretation.
- **A sidebar nav item**, inside the existing `Auth.isOwner()` guard beside Users:
  `${Auth.isOwner() ? navItem('audit', '#/audit', 'Audit Log', 'history') : ''}`.
- **`isOwnerOnlyRoute` in `renderApp()` gains `parts[0] === 'audit'`** — the same
  single-gate pattern Phase 5 §3 established, for a Staff user arriving by typed URL or
  stale bookmark. Server-side `RolesGuard` remains the actual enforcement point; this only
  avoids showing a screen that can only 403.
- **`Store.listAuditEvents(filters)`**, built exactly like `Store.listAllTransactions` —
  query-string assembly, `this._request('GET', '/audit-events?…')`.
- **One cross-link, and it is the point of the whole phase**: each row of
  `Views.userList` links to `#/audit?subjectUserId=<id>`, most visibly from the `locked`
  badge Phase 8 shipped. That badge currently states a fact an Owner can do nothing with;
  one click away from the account's own history, it becomes the start of a decision.

**`Store._request` needs no change.** A `403` on `/audit-events` for a Staff user who
forced the URL falls through the generic throw, exactly as the existing comment (extended
in Phase 8 to name `429`) describes. Verify; change nothing.

**Out of scope — explicitly:**

- **No live tail, polling, or auto-refresh.** This is a screen someone opens when they
  have a question, not a monitor. The same reasoning Phase 8 §3 used to refuse a countdown
  timer.
- **No CSV/JSON export.** §7.
- **No per-event detail drawer or modal.** The `summary` *is* the detail — §1 chose a
  human sentence over a diff precisely so there is nothing further to drill into. A drawer
  would be a UI affordance implying data the table deliberately does not store.
- **No charts, counts, or "failed logins this week" tile on the dashboard.** That is
  reporting/analytics, which `product.md` §7 keeps in Future, and it would give the
  dashboard its first piece of data not composed from FR-004/FR-031/FR-042 (BR-062's
  boundary).
- **No filtering by IP**, even if fork A ships. The column is evidence to read, not an
  index to pivot on, and §1 deliberately did not index it.

---

## 4. Documentation updates

1. **`business-rules.md`** — a new **Audit Log** section after Authorization, since these
   are neither authorization rules nor inventory rules:
   - **BR-082** — **Every administrative and authentication event is recorded, and the
     record is append-only.** A closed list of event types (§1) is written to
     `audit_events` as it happens; rows are never updated or deleted by any code path in
     this application. The record names the **actor** (the authenticated principal who
     acted, NULL for anonymous events) and the **subject** (the account the event is
     about) as two distinct facts — a failed login has a subject and no actor, because the
     person who typed the wrong password is precisely not the account holder. Recording is
     **best-effort**: a failed audit write never fails the operation it describes, so the
     log is a *record*, not a *proof*. If fork A ships, one sentence noting that the
     client address is captured on authentication events and that this is personal data in
     a table with no retention limit.
   - **BR-083** — **Stock movements are not duplicated into the audit log.**
     `inventory_transactions` is already the immutable, attributed record of every
     stock-in, stock-out, and adjustment (BR-050, BR-051). The audit log records what
     happens *to* the system — accounts, roles, credentials, catalog data, authentication
     — never what happens *in* it. Two records of one fact could drift, and the ordinary
     daily traffic would bury the handful of administrative events the log exists for. →
     BR-050, BR-051
   - **BR-084** — **The audit log is Owner-only.** It contains failed login attempts
     against named accounts — not merely which accounts exist, but which are currently
     being attacked and which are close to lockout. Phase 3 closed enumeration from the
     outside and BR-081 closed it from a second direction; opening this read to Staff
     would reopen it from the inside. Enforced by a class-level `@Roles(UserRole.Owner)` on
     `AuditController`, the second controller to use the class-level form after BR-074's
     `UsersController`. → FR-065, BR-074
   - **BR-078** gains a cross-reference: an Owner's reset is recorded as
     `user_password_reset` (BR-082), and the lock it clears is visible in the same log.
   - The "Rules Explicitly Deferred" list keeps its Q-6 line unchanged.

2. **`requirements.md`** — **FR-065 (View audit log, Should)** in the "User Attribution &
   Accounts" section beside FR-063/FR-064, with the same operability-not-MVP-correctness
   note. This is the first FR added since Phase 6, and the section's two "no new FR" notes
   (Phases 7 and 8) stay exactly as they are — the contrast between them and this entry is
   the point, and §1 explains it.

3. **`product.md`** — the phase's one product-level edit, and flagged as such:
   - §4 gains a user goal: *"Know who changed what, and when — for accounts and catalog
     data, not just stock."*
   - §5 gains a use case: *"An Owner reviews the audit log after a colleague reports they
     cannot sign in."*
   - §11 gains a Phase 9 cross-reference in the style of the Phase 7 entry, stating
     explicitly that this resolves none of Q-4, Q-6, or Q-7, and in particular that an
     audit log is not an approval workflow (Q-6).

4. **`domain-model.md`** — `Audit Event` added to §3's entity table (Included; supporting,
   owns no invariants of the core domain), a short §4 responsibility paragraph, and — most
   usefully — a line in §8 noting that `audit_events` is the **second** instance of the
   immutable-table rule, after `inventory_transactions`. §8 currently reads as a rule with
   one worked example; a second instance is what makes it a convention rather than a
   description.

5. **`api.md`** — title bumped to Phase 9; a new **Audit Log** section documenting `GET
   /audit-events` with its filters, its `limit` cap, its Owner-only marker, and the
   nested-`actor`/`subject` read shape. The Users section gains a sentence noting that
   every write on that controller is now recorded. No other route's documented behavior
   changes — the administrative routes gain an audit side effect, not a new response shape
   or status code, and saying so explicitly is worth a line.

6. **`architecture-observations.md`** — a new cross-cutting note, and a genuinely
   load-bearing one for that file's stated purpose. **The audit log is the closest this
   system has come to the Kafka criterion that file already names — and it still does not
   meet it.** That file says Kafka earns its place "the moment there's a second real
   consumer of inventory change events." This phase builds a second consumer of *events*,
   but §1 deliberately excludes inventory events from it: the audit log consumes
   administrative and authentication events, for which there was previously no producer at
   all. So the bar remains unmet, and this phase is *evidence for* that conclusion rather
   than against it — exactly the kind of concrete data point the file was created to
   accumulate instead of speculation. Two shorter additions: the best-effort audit write
   as a second instance of "correct at this scale, a named precondition at another"
   (beside the in-memory throttle store), and the `timestamptz` count going from six
   columns to seven.

7. **`docs/learning-notes/cross-cutting-concerns.md`** — **a new learning note**, the
   first new file in that folder since Phases 5, 6, and 8 each deliberately chose to
   *extend* `authentication-and-guards.md` rather than add one; the addition is itself a
   judgement call and is recorded as such rather than slipped in. Its
   subject is §1's three-mechanism comparison — **global interceptor vs. TypeORM entity
   subscriber vs. explicit service call** — which is a NestJS-shaped lesson that does not
   belong under "authentication and guards" and generalizes past this one feature: *the
   most automatic mechanism is the one that knows the least about what happened.* It picks
   up the thread `authentication-and-guards.md` started with global guard ordering and
   carries it to the general question of where a cross-cutting concern should live.

8. **`docs/learning-notes/authentication-and-guards.md`** — extended once more, with one
   thing only: **the actor/subject distinction as a security-modeling rule**, not just a
   schema decision. It sits naturally beside the enumeration-ordering rule that file
   already generalizes from Phases 6 and 8 — both are cases of *being precise about what a
   piece of data actually proves.*

9. **`README.md`** — Current phase section updated. Two notes in the spirit of the
   existing Riley and lockout ones: the audit log is **empty on a fresh `npm run seed`,
   and that is correct** (§2 — a seeded log would be fiction), and it lives at `#/audit`,
   Owner-only. If fork A ships, the existing `trust proxy` paragraph gains one sentence
   promoting it from a throttling caveat to a log-correctness one.

---

## 5. Testing plan

Four properties here are easy to get silently wrong — the actor/subject confusion, a
best-effort write that isn't, stock movements leaking into the log, and a Staff user
reading it — and each gets a pinning test.

- **Unit — `audit.service.spec.ts`** (new):
  - `record()` persists the given event type, actor, subject, entity, and summary.
  - **A repository failure does not propagate.** `save` rejects; `record()` resolves
    anyway. This is the best-effort property from §1 and **no other test in the suite would
    catch its loss** — a future refactor that removes the `try/catch` passes everything
    else and turns every audit failure into a 500 on a user's password reset.
  - `findAll()` applies each filter and respects `limit`.

- **Unit — `auth.service.spec.ts`** (extended; the file already mocks the repository and
  deliberately does not mock bcrypt):
  - A failed login for an **unknown email** records `login_failed` with **both** actor and
    subject `null` — and does not throw.
  - A failed login for a **known email** records `login_failed` with `actor: null` and
    `subject: <the user>`. **This is the ordering pin of the phase**, the exact analogue of
    Phase 6's "don't move the status check to the top" and Phase 8's "a wrong password
    against a locked account returns the generic message." Without it, a plausible
    "simplification" that fills in `actor` from the matched user passes every other test in
    the file while quietly making the actor column mean two different things.
  - A successful login records `login_succeeded` with the subject set.
  - A rejected-because-deactivated and a rejected-because-locked attempt each record
    `login_failed`, not a new type.

- **Unit — `users.service.spec.ts`** (extended): `account_locked` is recorded **exactly
  once**, on the failure that crosses the threshold — not on the (N−1)th, and **not** on a
  subsequent failure while already locked. That last assertion is the one that pins §1's
  once-per-lock semantics to Phase 8's early return, so a change to either notices the
  other.

- **Unit — `products.service.spec.ts` / `suppliers.service.spec.ts` /
  `categories.service.spec.ts`** (extended): each write method records its event with the
  actor it was passed. Mostly mechanical, and the reason they are listed here is §1's
  warning — these files' existing constructor mocks and call signatures **must** be updated
  for the new `AuditService` dependency and `actorId` parameter, and that is this phase's
  most likely regression by a wide margin. Unlike Phases 6–8, no column default protects
  them.

- **E2E — `audit.e2e-spec.ts`** (new, real Postgres, using the existing harness shape):
  - **Owner-only**: a Staff token gets `403`; an Owner gets `200`. Pins BR-084 and the
    enumeration argument behind it.
  - **The lockout round trip end to end**: fail a login five times against a seeded
    account, then read the log as an Owner and find five `login_failed` rows plus exactly
    one `account_locked`, all with the right subject and `actor: null`. This is the
    headline user story of the phase, asserted as a whole rather than in pieces.
  - **An administrative change records its actor**: an Owner changes another user's role;
    the log shows `user_updated` with `actor` = the Owner, `subject` = the target, and a
    summary naming both roles.
  - **No stock movement appears in the log** — record a stock-in and a stock-out through
    the API, then assert the audit log is unchanged. This is the **non-change test**, the
    direct analogue of Phase 7's "a transaction response has no `updatedAt`" and Phase 8's
    "a locked account's existing token still works." It would fail loudly if someone
    "completed the set" by adding audit calls to `InventoryService`, which is exactly the
    well-intentioned change §1 exists to prevent.
  - **The joined read leaks nothing**: an event's nested `actor` and `subject` carry no
    `passwordHash`, no `failedLoginAttempts`, no `lockedUntil`. Asserted rather than
    assumed, on the same grounds Phase 8 asserted the `429` body shape — the protection is
    real but it is a property of a decorator on a different file.
  - **The cap holds**: `?limit=2` returns two rows; `?limit=100000` returns `400`.
  - If fork A ships: a `login_failed` row carries a non-null `actorIp`, and an
    administrative event's is `null`.

- **Existing suites — must pass, with one known and bounded exception.** The five e2e
  specs are unaffected: `audit_events` is a new table nothing else touches, and no existing
  raw `INSERT INTO users (…)` mentions it. The four service unit specs above **are**
  affected, by design, per §1. That asymmetry — e2e untouched, unit specs updated — is the
  honest shape of this phase and is why §6 gives the signature change its own step.

- **No new integration-layer test** — consistent with Phases 3–8. The one
  concurrency-adjacent property here is that an audit write is not atomic with the
  operation it describes, and §1 accepts that deliberately; a test pinning it would be
  pinning something the design explicitly does not guarantee.

---

## 6. Rollout order

1. **Enums, entity, migration, `AuditModule` + `AuditService` with no callers**, plus the
   entity registered in **all three** data-source registries (§2). Then run the full suite
   with zero test changes. Nothing calls `record()` yet; nothing reads the table. If
   anything goes red here it is a wiring problem, found before any behavior depends on it —
   the same de-risking step Phase 8 put first.
2. **`GET /audit-events` + the query DTO + the Owner-only controller**, with the e2e tests
   for the empty case and the Staff `403`. Still no writes anywhere: the endpoint returns
   `[]`, correctly. The read contract is fixed before there is any data whose shape could
   pull it around.
3. **The authentication half** — `AuthService.validateUser` and
   `UsersService.registerFailedLogin` record their four event types, with their unit tests.
   **First real data.** This half goes first deliberately: both call sites already have
   the user in hand, so it costs **no signature changes anywhere**. It is also the half
   that answers the Phase 8 `locked`-badge question, so if the phase stopped here it would
   have delivered its headline.
4. **The administrative half** — `@CurrentUserId()` threaded through `UsersController`,
   `ProductsController`, `SuppliersController`, and `CategoriesController`; ~12 service
   signatures; their `record()` calls; and the four unit specs updated. **The big
   mechanical step, isolated on purpose** (§1), so a noisy diff here sits on top of a
   green tree rather than on top of a behavior change.
5. **Frontend** (§3): `#/audit`, the nav item, the router gate, `Store.listAuditEvents`,
   and the Users-row cross-link.
6. **Documentation** (§4) — the BR-082–084 entries, FR-065, the `product.md` §4/§5 edits,
   and the two learning notes are the deliverables that outlast the code, so they are not
   optional in any cut of this phase.

Steps 1–2 are no-ops from every client's point of view. Steps 3 and 4 change no existing
route's response — they add a side effect and nothing else — which is the same
"individually shippable, nothing before step N has to be reverted if step N goes wrong"
property Phases 5 through 8 all arranged for.

If the owner takes the by-category cut named in §1's fork B, the line falls cleanly after
step 3 plus its share of step 5: the authentication half, its screen, and BR-082/BR-084
ship as Phase 9, and step 4 becomes Phase 10.

---

## 7. Explicitly out of scope for Phase 9 (Future)

- **A retention or pruning policy** — and unlike most entries here, this one has a
  concrete trigger rather than a vague someday. `audit_events` grows without any user
  acting (§1), almost entirely from `login_failed`. When the table is large enough to
  notice — a slow audit screen, or a backup size that surprises someone — the answer is a
  scheduled `DELETE FROM audit_events WHERE created_at < now() - interval '1 year'`. It is
  out now because this project has no scheduler of any kind, and adding one to run a
  cleanup nobody yet needs would be the premature infrastructure
  `architecture-observations.md` has argued against since Phase 2.
- **Export (CSV, JSON, or a printable view)** — a real request the moment someone needs to
  send the log to an accountant or an insurer, and a genuinely separate feature (a format
  decision, a download route, a filename convention). Not needed to answer the question
  this phase exists to answer.
- **Field-level before/after diffs, or a JSONB payload column** — §1 rejected this on the
  merits, not on scope. Reopening it would mean reopening the credential-leak argument,
  which is the part that would need a new answer.
- **Logging reads, or logging `429`s** — §1, both with their own reasons; the `429` one in
  particular because writing a row per rejected request would turn a defense into an
  amplifier.
- **Duplicating stock movements into the audit log** — BR-083. If a future phase ever
  wants one unified activity feed across both tables, that is a *read-side* composition
  (the shape `DashboardService.getSummary` already uses), never a second write.
- **Tamper-evidence — hash chaining, append-only database roles, WORM storage, or shipping
  the log off-box** — the controls that would make this a *proof* rather than a *record*
  (§1, BR-082). Every one of them is a meaningful operational commitment, and none has been
  asked for by a business whose threat model is "which of the four of us changed this."
- **Alerting on audit events** — "email me when an account locks." There is still no mail
  transport in this project (BR-078), exactly as Phases 6 and 8 both recorded, and this
  phase does not add one.
- **A dashboard tile or chart derived from the log** — §3; it would be the dashboard's
  first data not composed from FR-004/FR-031/FR-042, crossing the boundary BR-062 drew.
- **Making the audit log writable, correctable, or annotatable** — no route, no service
  method, no "add a note to this event." The absence is the feature.
- **A shared throttle store** (Phase 8 §7) — still parked, still recorded in
  `architecture-observations.md`, still not this phase's problem.
- **The `timestamptz` schema-wide question** (Phase 7 §7) — deferred a third time, for the
  same reason, now noted with a column count so the next decision has a number (§1, §4).
- **Q-4 (sale concept) and Q-7 (multi-location)** — untouched, as in every phase since 5.
- **Q-6, adjustment approval workflow** — still open, still untouched, and explicitly *not*
  resolved by this phase despite the surface resemblance: a log records what happened, an
  approval gates what may happen (§1).

---

## 8. Definition of done

- [x] `audit_events` exists with `event_type`, `actor_user_id`, `subject_user_id`,
      `entity_type`, `entity_id`, `summary`, `created_at` (and `actor_ip` if fork A
      shipped), created in one migration, with `AuditEvent` registered in **all three**
      data-source registries (`database.module.ts`, `data-source.ts`,
      `test-data-source.ts`).
- [x] The table has no `updated_at`, no update or delete route, and no service method that
      changes or removes a row — the second instance of `domain-model.md` §8's
      immutable-table rule, and `domain-model.md` §8 says so.
- [x] `actor_user_id` and `subject_user_id` are distinct columns with distinct meanings,
      pinned by a test asserting that a failed login for a **known** email records
      `actor: null` and `subject: <that user>` — so a later "simplification" cannot quietly
      make the actor column mean two things.
- [x] `entity_id` carries **no** foreign key, and a `product_deleted` event survives the
      deletion of the product it names — asserted, not assumed.
- [x] A failing audit write **does not fail** the operation it describes, with a unit test
      that would catch the loss of the `try/catch`; and `business-rules.md` says the log is
      a record, not a proof.
- [x] Every event in §1's closed list is recorded, with the right actor and subject, from
      the service that performs it — and **no stock-in, stock-out, or adjustment appears in
      the log**, asserted by a non-change e2e test.
- [x] `GET /audit-events` is Owner-only (Staff gets `403`, asserted), newest-first,
      filterable by event type, actor, subject, and days, and capped at 500 rows with a
      `400` for a larger request.
- [x] The nested `actor`/`subject` objects on an audit read carry no `passwordHash`,
      `failedLoginAttempts`, or `lockedUntil` — asserted, not assumed.
- [x] `account_locked` is recorded exactly once per lock, at the transition, with a test
      proving a subsequent failure during the lock does not add a second one.
- [x] The frontend has an Owner-only `#/audit` screen behind the same single route gate as
      `#/users`, and the Users list links each account to its own filtered history —
      Phase 8's `locked` badge now leads somewhere.
- [x] `business-rules.md` (BR-082–084, with BR-078 cross-referenced), `requirements.md`
      (FR-065, with Phases 7 and 8's "no new FR" notes left intact), `product.md` (§4 goal,
      §5 use case, §11 cross-reference), `domain-model.md` (§3, §4, §8), `api.md` (Phase 9),
      `architecture-observations.md` (the Kafka-criterion finding), `README.md`, and both
      learning notes reflect this phase — and Q-4, Q-6, and Q-7 are still recorded as open.
- [x] The two scope forks were decided and recorded either way: client-IP capture on
      authentication events (§1 fork A) shipped with its test and its `trust proxy` note,
      or is written down as deliberately omitted; and the phase shipped whole or was cut by
      **event category** rather than by layer (§1 fork B).
- [x] Full backend suite green: unit (including the four updated service specs), integration,
      all five existing e2e specs, and the new `audit.e2e-spec.ts`.
