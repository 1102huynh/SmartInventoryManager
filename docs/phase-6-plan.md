# Phase 6 Plan — User Management (Owner-Administered Accounts)

Status: Phase 6 — Planned
Last updated: 2026-08-21
Scope decided with the project owner: **make users a managed resource — an Owner can
create, edit, deactivate, and reset the password of any account; every user can change
their own password** — and nothing else. Scoped the same way `phase-3-plan.md` was
scoped to authentication and `phase-5-plan.md` to authorization: one headline change,
an explicit out-of-scope list, no punch-list riding along.

## Why this phase, why now

Phase 5 shipped the Owner/Staff split, and its out-of-scope list (§7) opens with the
one item it called "the obvious follow-on" in §1:

> **User management** — no signup, no admin screen, no `PATCH /users/:id/role`. Roles
> are set in the database, as users already are.

That deferral was right at the time — it would have doubled Phase 5's surface area and
pulled in questions the role split didn't need to answer. But it left the system in a
state where the thing Phase 5 built is unusable without a `psql` prompt. A business
owner who hires someone cannot give them an account. A business owner whose staff
member leaves cannot revoke their access. A staff member who forgets their password has
no path back in at all, because Phase 3 deliberately built no self-service signup and
no password reset. Every one of those is a `UPDATE users SET …` today, run by whoever
has database access — which in a 1–10 person business (A-1) is nobody.

So the gap this phase closes is not a missing requirement in the priority table — there
isn't one; FR-060, FR-005, and FR-062 are all Done — it is that Phase 5's roles are
currently *provisioned* by a mechanism no user of this product has. It also answers the
two questions Phase 5 §1 raised and set aside verbatim: **can an Owner demote the last
Owner?** (no — BR-075) and **who creates the first one?** (the seed, unchanged — there
is no bootstrap endpoint).

One thing this phase gets almost for free, and which is worth naming up front because
it changes a Phase 3 decision's practical meaning: **deactivating a user takes effect on
their next request, not at their next token expiry.** Phase 3 declined to build a token
revocation list ("Logout: client-side only, no revocation list"), and Phase 5 then made
`JwtStrategy.validate` read the user from the database on every authenticated request.
Adding a status check to that same lookup gives the one revocation case that actually
matters — *this person no longer works here* — without any of the server-side token
state Phase 3 was avoiding. See §1.

---

## 1. Design decisions

### Users are deactivated, never deleted

`inventory_transactions.recorded_by_user_id` is a `RESTRICT` foreign key
(`InventoryTransaction.recordedBy`, `@ManyToOne(() => User, { onDelete: 'RESTRICT' })`),
for exactly the reason BR-004 blocks deleting a product with history: FR-061 attribution
is worthless if the row it points at can vanish. So a `DELETE /users/:id` could only
ever succeed on a user who has never recorded a single transaction — which is to say,
once per account, briefly, and never again.

Products got both a delete *and* a deactivate because a product created by mistake and
never transacted against is a real, recurring case worth cleaning up. A user is not:
the account exists because a person exists, and when the person stops working here the
correct outcome is a preserved, non-functional account, not a hole in the audit trail.
So there is **no user delete endpoint at all** — not "delete when possible, 409
otherwise," which would be a route that mostly fails and teaches Owners to expect
failure. `PATCH /users/:id/status` is the whole lifecycle.

`users` therefore gains a `status` column, reusing the existing `EntityStatus`
(`'active' | 'inactive'`) that `Product.status` and `Supplier.status` already share, as
`users_status_enum` — the same per-table-enum-over-shared-TS-enum pattern InitSchema
established, and the same one `users_role_enum` followed in Phase 5.

### Deactivation is what token revocation turned out to be

An inactive user must be stopped in two places, and missing either one makes the feature
a lie:

1. **`AuthService.validateUser`** — an inactive user cannot obtain a new token.
2. **`JwtStrategy.validate`** — an inactive user's *existing, unexpired* token stops
   working on their very next request.

Only (1) is obvious; (2) is the one that matters. Tokens last 12 hours
(`docs/phase-3-plan.md`), so without (2) an Owner who deactivates someone at 9am has
deactivated them at 9pm. The strategy already does a per-request primary-key lookup and
already throws `UnauthorizedException` for a user that no longer exists — an inactive
user is the same category of "this token no longer identifies someone who may be here,"
and costs nothing extra, because the row is already loaded.

This is worth stating plainly in the learning notes: **Phase 3 declined a revocation
list, and Phase 5's "look the role up per request" decision, made for an unrelated
correctness reason, turned out to have already paid for revocation.** The general case
(revoke *this token*) is still not supported and still isn't wanted; the specific case
(revoke *this person*) now is.

### The login failure message for a deactivated account is deliberately *not* generic

Phase 3 made "unknown email" and "wrong password" return an identical `401`, so the
endpoint can't be used to enumerate registered emails (`AuthService.validateUser`'s
comment says so explicitly). A deactivated account gets a **different** message —
"This account has been deactivated. Ask an Owner to reactivate it." — and that does not
weaken the Phase 3 property, because of *where the check runs*: **after** the bcrypt
comparison succeeds. Reaching that message requires already knowing the correct
password, which an enumerator by definition does not. Ordering the check the other way
round (status first, cheaply, before the hash compare) would leak exactly what Phase 3
closed off, so the ordering here is load-bearing and needs a comment saying so.

The alternative — a generic 401 for a deactivated user — means a staff member whose
account was switched off spends their morning retyping a password that is, in fact,
correct. That is a bad experience bought with no security.

### At least one active Owner must always exist (BR-075)

The invariant Phase 5 flagged and left open. Without it, one wrong click leaves a system
with no Owner: nobody can create products, nobody can manage users, and the only
recovery is the `psql` prompt this phase exists to eliminate. Enforced in `UsersService`
on the two paths that can violate it — demoting an Owner to Staff, and deactivating an
Owner — as a `409` (`ConflictException`), the code `api.md` already assigns to
business-rule violations.

Two clarifications the implementation has to get right:

- **"Active" is part of the rule.** The count is of Owners with `status = 'active'`. A
  deactivated Owner cannot log in, so counting them would permit a state that satisfies
  the letter of the invariant while locking everyone out in practice.
- **An Owner may demote or deactivate themselves**, provided another active Owner
  remains. The rule is about the system, not about self-harm. A narrower "you can't
  modify your own account" rule would be both more annoying (an Owner can't fix a typo
  in their own name) and weaker (it still permits Owner A to demote the only other
  Owner and then be deactivated by nobody). The one consequence: a self-demoting Owner
  loses the users screen immediately, which the frontend handles by re-fetching
  `/auth/me` after any write to one's own record (§3).

### Passwords: the Owner sets them, and there is no email in this system

Three flows, one of which deliberately does not exist:

| Flow | Route | Who |
|---|---|---|
| Set the initial password when creating an account | `POST /users` (`password` field) | Owner |
| Change my own password | `PATCH /auth/password` (`currentPassword` + `newPassword`) | Any authenticated user |
| Reset someone else's password | `PATCH /users/:id/password` (`newPassword`) | Owner |
| ~~Emailed password reset link~~ | — | — |

**The Owner types the initial password rather than the system generating one.** A
generated credential needs a shown-once-never-again panel, a copy control, and a story
for what happens when the Owner closes the tab — real UI for no gain in a business where
the Owner is handing the credential to the person across the counter. There is also no
`mustChangePassword` flag and no forced-change-on-first-login redirect: that is a state
machine (a column, a route exemption, a guard carve-out) for a workflow nobody asked
for.

**`PATCH /auth/password` requires the current password even though the caller is already
authenticated**, because a valid token proves who opened the tab, not who is sitting at
it now. This is the standard reason and it applies here as much as anywhere.

**`PATCH /users/:id/password` is a *reset*, not a *recovery*.** The Owner sets a new
password and tells the person; the old one is not retrievable and is not shown. With no
mail transport anywhere in this project — and no intention to add one (§7) — this is
the only forgot-my-password path that can exist, and it is a perfectly good one at this
scale.

**Password policy is a floor, not a policy**: `@MinLength(8)`, nothing else. No
complexity rules, no breach-list checks, no rotation. The seeded dev password
(`password123`, 11 characters) still passes, so the README's sign-in table stays true.

### `GET /users` becomes Owner-only — an explicit amendment to BR-073, not a quiet exception

BR-073 says every read is open to both roles. This phase narrows that for `/users`
specifically, and the honest thing is to record it as an amendment rather than let the
two documents disagree.

The reasoning BR-073 rests on, from `phase-5-plan.md` §1, is that "a single-location
small team of 1–10 people does not need read segmentation" — and that argument is about
*inventory* data: stock levels, transaction history, the dashboard. The user list is a
different kind of read. It is the index page of an administrative screen Staff cannot
use, and after this phase it carries every colleague's login email and account status.

The decisive point is internal consistency: Phase 3 went out of its way to make
`POST /auth/login` return an identical `401` for an unknown email and a wrong password
so that the API could not be used to enumerate registered emails. Leaving `GET /users`
open to Staff makes that care pointless from inside the app — any signed-in user could
just read the list. Two decisions that contradict each other is worse than either one.

What does **not** change: transactions still embed `recordedBy` as a nested user object
(see `api.md`, Inventory reads), so Staff continue to see *who* recorded what. Names
were never the concern; login identifiers are.

### `UsersController` gets a class-level `@Roles(UserRole.Owner)` — the first one in the app

`ProductsController` and `SuppliersController` both carry a comment explaining that
`@Roles()` is applied *per route* there, precisely because their `GET` routes stay open
to everyone. `UsersController` is the opposite case: after the decision above, every
route on it is Owner-only, so the class-level form is correct and a per-route repetition
would be six identical decorators inviting the seventh to be forgotten.

This is why `PATCH /auth/password` lives on `AuthController` rather than as
`PATCH /users/me/password`: putting the one everybody-can-use route on `UsersController`
would force the per-route form back and lose that property. It also simply belongs next
to `/auth/login` and `/auth/me` — it is about the caller's own credentials, not about
administering somebody.

`RolesGuard`'s `getAllAndOverride(ROLES_KEY, [getHandler(), getClass()])` already reads
class-level metadata; no guard change is needed for this.

### Role changes ride on `PATCH /users/:id`, not a separate `PATCH /users/:id/role`

Phase 5 §7 used `PATCH /users/:id/role` as shorthand for "user management doesn't exist
yet"; it was not a route design. Status is a separate endpoint on Products and Suppliers
because status is a *lifecycle transition* with its own confirm-and-warn UI. Role is an
attribute of the account, like the name and the email, and an Owner correcting a new
hire's record shouldn't need two requests to fix a typo and set them to Staff. So role
goes in the general update DTO — which means BR-075's last-Owner check runs inside the
general update path, not only in a dedicated role endpoint. Worth a comment at the
check, since that is where it would be easy to miss.

`PATCH /users/:id/status` stays separate, mirroring products and suppliers exactly.

### Email is editable; the SKU precedent does not apply

BR-001 blocks changing a product's SKU once transactions exist, which invites the
analogy "so a user's email should freeze too." It shouldn't. A SKU is the domain
identity that history is *about*; an email is a login credential, and transactions
reference `recorded_by_user_id`, never the email. Editing it rewrites nothing. An Owner
who typos a colleague's address otherwise has to create a second account and abandon the
first — a permanent scar for a five-second mistake.

Uniqueness is still enforced (the `UQ_users_email` index from Phase 3), surfaced as a
`409` the same way a duplicate SKU or category name is. There is no verification email,
because there is no email.

### Password hashing moves to one place

Today `bcrypt` appears in `AuthService.validateUser` (compare) and `run-seed.ts` (hash,
cost factor 10). This phase adds hashing in two more places (create user, change/reset
password) and a second compare (verifying `currentPassword`). Four call sites and a cost
factor that must not drift is the point at which a shared helper stops being
over-engineering: `src/common/password.ts` exporting `hashPassword(plain)` and
`verifyPassword(plain, hash)`, with `BCRYPT_ROUNDS = 10` defined once.

Note the direction this has to go: hashing belongs in `UsersService`, **not** in
`AuthService` called from `UsersService`. `AuthModule` imports `UsersModule`; the
reverse dependency would be a module cycle. The shared function sidesteps that
entirely — neither service needs the other.

This is a refactor riding along, which the previous phases' scoping discipline would
normally reject. It is included because the phase *creates* the drift risk rather than
merely noticing it; it is two functions; and it is step 1 of §6 precisely so it can be
verified as a no-op before anything else lands.

### No self-service signup — still

Phase 3 decided it, and nothing here changes it. Accounts are created *by an Owner*,
never by the person who will use them. The first Owner still comes from `npm run seed`.

---

## 2. What's new (backend)

### `users.status` + migration

- `User.status` — `@Column({ type: 'enum', enum: EntityStatus, default: EntityStatus.ACTIVE })`,
  the identical declaration `Product.status` and `Supplier.status` already use.
- New migration `…-AddUserStatus.ts` (any timestamp sorting after
  `1787290000000-AddUserRoleEnum`), following the same add-then-constrain shape as
  `AddAuthToUsers1787194988413` and `AddUserRoleEnum1787290000000`:
  1. `CREATE TYPE "public"."users_status_enum" AS ENUM('active', 'inactive')`
  2. `ALTER TABLE "users" ADD COLUMN "status" "public"."users_status_enum"`
  3. `UPDATE "users" SET "status" = 'active' WHERE "status" IS NULL` — every existing
     account stays usable. A migration must never be able to lock anyone out.
  4. `ALTER TABLE "users" ALTER COLUMN "status" SET NOT NULL`, then
     `ALTER COLUMN "status" SET DEFAULT 'active'`.
  - `down()` drops the column and the type.

  **The `DEFAULT 'active'` is not decoration.** All four existing e2e specs seed users
  with raw `INSERT INTO users (name, role, email, password_hash) …` —
  `app.e2e-spec.ts`, `auth.e2e-spec.ts`, `categories.e2e-spec.ts`, and
  `roles.e2e-spec.ts`. With the default, none of them need touching; without it, all
  four break at once on a `NOT NULL` violation. It also matches `products`/`suppliers`,
  which InitSchema created as `NOT NULL DEFAULT 'active'`.

- `run-seed.ts` — the three demo users gain `status: EntityStatus.ACTIVE`, and a
  **fourth, deactivated Staff user** is added (e.g. Riley Chen, `riley@example.com`,
  inactive, with no transactions attributed to them) so the Users screen demonstrates
  both states out of the box. This is the same reasoning the seed already applies to
  Sunrise Wholesale, the inactive supplier that `ui-open-questions.md` Q-UI-5 depends
  on. Giving them no transactions keeps every existing attribution and every dashboard
  number exactly as it is.

- `auth.service.spec.ts` constructs a `User` object literal; adding a required field to
  the entity breaks its compile. That edit is part of step 2, not a surprise in step 5.

### `src/common/password.ts`

```
const BCRYPT_ROUNDS = 10;
export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);
```

`AuthService.validateUser` and `run-seed.ts` switch to it in step 1; `UsersService` uses
it from step 4.

### `UsersService` stops being read-only

The class comment currently says "Read-only on purpose — there's still no 'create a
user' use case." That comment is what this phase invalidates, and rewriting it (rather
than leaving it to rot) is part of the work.

New methods, all of them the only place their invariant is enforced:

- `create(dto)` — hashes the password, `409` on duplicate email.
- `update(id, dto)` — name / email / role. `409` on duplicate email; `409` via
  `assertOwnerRemains` when demoting the last active Owner.
- `setStatus(id, status)` — `409` via `assertOwnerRemains` when deactivating the last
  active Owner.
- `setPassword(id, newPassword)` — the Owner's reset. No current-password check.
- `changeOwnPassword(id, currentPassword, newPassword)` — verifies `currentPassword`
  first; `401` (not `403`, not `400`) when it doesn't match, because the failure is
  "you have not proven you are this user," which is what `401` means.
- `private assertOwnerRemains(userId)` — counts `role = 'owner' AND status = 'active'`
  users other than `userId`; throws `ConflictException` at zero. One helper, called from
  both `update` and `setStatus`, so the two paths cannot drift apart.

`findOne` keeps its `NotFoundException`, which `JwtStrategy.validate` still catches and
converts — that interaction must not regress (see §5).

### DTOs

- `CreateUserDto` — `name` (`@IsString @IsNotEmpty`), `email` (`@IsEmail`), `role`
  (`@IsEnum(UserRole)`), `password` (`@IsString @MinLength(8)`).
- `UpdateUserDto` — the same three non-password fields, all `@IsOptional`.
- `SetUserStatusDto` — `@IsEnum(EntityStatus)`, mirroring `SetProductStatusDto`.
- `SetUserPasswordDto` — `newPassword`.
- `ChangePasswordDto` — `currentPassword`, `newPassword`.

None of them accept `passwordHash`, and the global `ValidationPipe`
(`whitelist: true, forbidNonWhitelisted: true`) rejects it with a `400` if anyone
tries. Responses are already safe: `@Exclude()` on `User.passwordHash` plus the global
`ClassSerializerInterceptor` strips it from every serialized user, including the nested
`recordedBy` on transactions. New routes inherit both — nothing extra to do, but worth
confirming in a test rather than assuming (§5).

### Routes

| Controller | Route | Role | Notes |
|---|---|---|---|
| `UsersController` (class-level `@Roles(UserRole.Owner)`) | `GET /users` | Owner | Now Owner-only — BR-074 |
| | `GET /users/:id` | Owner | new |
| | `POST /users` | Owner | new; `201` |
| | `PATCH /users/:id` | Owner | new; name / email / role |
| | `PATCH /users/:id/status` | Owner | new |
| | `PATCH /users/:id/password` | Owner | new; reset, no current password |
| `AuthController` | `PATCH /auth/password` | any authenticated | new; `@CurrentUserId()`, `204` |

### `AuthService.validateUser` and `JwtStrategy.validate`

- `validateUser` — after `verifyPassword` succeeds, reject an inactive user. The
  ordering comment from §1 goes here. Returning `null` would collapse it into the
  generic 401, so it needs a distinct signal: either throw the
  `UnauthorizedException('This account has been deactivated…')` from the service, or
  return a discriminated result the controller maps. Throwing from the service is
  simpler and keeps `AuthController.login` unchanged apart from a comment.
- `validate` — the existing `findOne(...).catch(NotFound → null)` block gains a
  status check, throwing the same `UnauthorizedException` shape it already throws for a
  deleted user. The existing comment about not swallowing transient DB errors stays
  exactly as it is; this adds a case, it does not restructure the block.

---

## 3. Frontend changes

The server is the enforcement point, as in Phase 5; everything here is presentation and
convenience.

- **A conditional sidebar item.** `shellTemplate()`'s nav gains `Users`, rendered only
  when `Auth.isOwner()`. Phase 5 §7 ruled out "per-role UI beyond hiding owner-only
  actions — no separate Staff dashboard, no role-specific landing page," and this is a
  narrow amendment to that, not an exception smuggled in: it is still hiding an
  owner-only action, it just happens to be a nav entry rather than a button. The
  alternative — burying the screen behind a user-chip menu that does not exist yet —
  would mean building a menu to avoid admitting the sidebar varies.

- **New routes**, added to the `isOwnerOnlyRoute` expression in `renderApp()` alongside
  the existing products/suppliers/categories entries:
  `#/users`, `#/users/new`, `#/users/:id/edit`.

- **One new route that is *not* owner-only**: `#/account`, the self-service password
  change, reachable from the user chip. This is the first non-dashboard route both roles
  share equally, and it must not be added to `isOwnerOnlyRoute` — an easy mistake given
  everything else in this phase.

- **`Views.userList`** — name, email, role, status, following `Views.supplierList`'s
  table shape. Inactive rows get the same muted treatment inactive suppliers already
  have. **The signed-in Owner's own row is marked "you"**, because the deactivate
  control on that row is the one with a consequence they should see coming.

- **`Views.userForm`** — create and edit, the same one-view-two-modes pattern as
  `Views.productForm` / `Views.supplierForm`. The password field appears only in create
  mode; editing a user never shows or asks for a password.

- **Deactivate / reactivate** uses the existing inline-confirm pattern from
  `Views.supplierDetail` (`confirmMode === 'toggle'`) rather than a new dialog.

- **`Views.account`** — current password, new password, confirm. Confirm-match is
  checked client-side (the server has no opinion about a field it never receives).

- **`CURRENT_USER` must be refreshed after a write to one's own record.** `CURRENT_USER`
  is set once at login and read by `Auth.isOwner()` and the user chip. An Owner who
  renames or demotes themselves would otherwise keep a stale role in memory until they
  sign out — the server would already be enforcing the new one, so the UI would offer
  buttons that 403. Fix: after a successful `PATCH /users/:id` where `id ===
  CURRENT_USER.id`, re-fetch `GET /auth/me` and reassign `CURRENT_USER`, then re-render.
  Store gets one small helper for this rather than each caller remembering.

- **The 403 handling from Phase 5 needs no change**, and the comment in
  `Store._request` explaining why a `403` must not clear the token is now doubly load-
  bearing: a self-demoted Owner will hit one, and logging them out would look like a
  crash.

- **Store methods**: `getUsers`, `getUser`, `createUser`, `updateUser`,
  `setUserStatus`, `resetUserPassword`, `changeOwnPassword` — the same thin
  `_request` wrappers as everything else in `Store`.

---

## 4. Documentation updates

1. **`requirements.md`** — under User Attribution (retitled **User Attribution &
   Accounts**):
   - **FR-063, "Manage user accounts"** (Should) — an Owner can create a user, edit
     their name/email/role, deactivate and reactivate them, and reset their password.
   - **FR-064, "Change own password"** (Should) — any authenticated user can change
     their own password by supplying the current one.

   Both are **Should**, not Must, and the Notes column should say why rather than
   quietly inflating them: `product.md` §7's MVP list does not include user
   administration, and the system is fully functional with seed-provisioned accounts.
   This phase closes an operability gap, not an MVP correctness gap.

   FR-062's note gains a pointer to FR-063 for how roles are now assigned.

2. **`business-rules.md`**, extending the Authorization section:
   - **BR-074** — user administration (including reading the user list) requires the
     Owner role. **Explicitly recorded as amending BR-073**, with §1's reasoning
     compressed to two sentences, and BR-073 itself edited to carry the carve-out so the
     two rules can't be read in isolation and contradict each other.
   - **BR-075** — at least one active Owner must exist at all times; a change that would
     leave zero is rejected. Names both paths (demotion, deactivation) and the
     "active" qualifier.
   - **BR-076** — users are deactivated, never deleted, to preserve FR-061 attribution.
     Cross-references BR-004 as the same principle applied to a different entity.
   - **BR-077** — an inactive user cannot authenticate, and an existing token for an
     inactive user is rejected on their next request.
   - **BR-078** — a user changes their own password by supplying the current one; an
     Owner may reset any password without it. No email-based recovery exists.
   - The "Rules Explicitly Deferred" list keeps its Q-6 line unchanged.

3. **`product.md`** — **A-5** updated a second time: user management is no longer
   deferred; what remains deferred is per-permission granularity beyond the two-role
   split, and self-service signup. §7's Future list keeps "Role-based access control
   beyond basic user attribution" only if it still means something after this phase —
   it doesn't, so it should be rewritten to name what is actually still future
   (per-permission rules, approval workflows), or dropped. **Q-6 stays open and
   untouched** — nothing in this phase resolves it, and an Owner-administered account
   system is not an approval workflow.

4. **`api.md`** — title bumped to Phase 6. The Users section is rewritten from its one
   current row into the six-route table from §2, with a note that the whole controller
   is Owner-only; `PATCH /auth/password` is added to the Auth section; the preamble's
   `401`-vs-`403` note gains the deactivated-account case (a deactivated user gets
   `401`, not `403` — they are not a wrong-role caller, they are not a caller at all).

5. **`docs/learning-notes/authentication-and-guards.md`** — extended again rather than
   joined by a new file, consistent with Phase 5's choice. Three additions:
   class-level vs. route-level guard metadata and when each is right; where password
   hashing belongs and why the module dependency direction forces it (`AuthModule` →
   `UsersModule`, never the reverse); and the section this phase most deserves — how
   a per-request database lookup added for authorization ended up providing session
   revocation that Phase 3 explicitly declined to build.

6. **`README.md`** — the sign-in table gains the fourth seeded user with a note that
   they cannot sign in (so an inactive demo account doesn't read as a broken seed), a
   line saying Owners manage accounts at `#/users` and everyone can change their own
   password at `#/account`, and the Current phase section updated.

---

## 5. Testing plan

- **Unit — `users.service.spec.ts`** (new; mocked repository, the style
  `suppliers.service.spec.ts` and `auth.service.spec.ts` already use):
  - `create` stores a bcrypt hash and never the plaintext — assert the persisted value
    is not the input and that `verifyPassword` accepts the input against it. bcrypt
    itself is **not** mocked, for the same reason `auth.service.spec.ts` states.
  - duplicate email on `create` and on `update` → `409`.
  - demoting the last active Owner → `409`; demoting an Owner while another **active**
    Owner exists → succeeds; demoting an Owner while the only other Owner is
    **inactive** → `409`. That third case is the one a naive `count(role='owner')`
    implementation passes the first two and fails.
  - deactivating the last active Owner → `409`.
  - `changeOwnPassword` with a wrong current password → `401`, and the stored hash is
    unchanged.

- **Unit — `auth.service.spec.ts`** (extended): a user with the correct password but
  `status = 'inactive'` is rejected, **and** the rejection happens after the hash
  comparison — assert that a *wrong* password on an inactive account produces the
  generic message, not the deactivated one. That is the assertion that stops someone
  "simplifying" the check to the top of the method and reopening the Phase 3
  enumeration hole.

- **Unit — `jwt.strategy.spec.ts`** (extended): an inactive user →
  `UnauthorizedException`; an active user → `{ id, role }` as before; the existing
  deleted-user and transient-DB-failure cases still pass unchanged. Note the happy-path
  test's mock currently resolves `{ id: 42, role: UserRole.Owner } as User` — it needs
  `status` added, or it fails at runtime once `validate` reads a field the mock doesn't
  have.

- **E2E — `test/users.e2e-spec.ts`** (new, cloning `roles.e2e-spec.ts`'s harness
  verbatim: `process.env.DB_DATABASE = 'smart_inventory_e2e'` before the imports, the
  same pipes/filter/interceptor wiring, `TRUNCATE … RESTART IDENTITY CASCADE` in
  `beforeEach`, users inserted with real bcrypt hashes):
  - Staff gets `403` on all six `/users` routes — **including `GET /users`**, since that
    is this phase's amendment to BR-073 and the one most likely to be reverted by
    someone reading BR-073 alone.
  - Owner creates a user; **that user can immediately `POST /auth/login`** — the
    round-trip that proves hashing on the write path and comparison on the read path
    agree. A test that only asserts `201` would pass with a broken hash.
  - **A deactivated user's existing, unexpired token returns `401` on the next
    request.** This is the most important test in the file: it is the entire difference
    between "revoked" and "revoked in twelve hours," and it is invisible in any test
    that logs in fresh after deactivating. Capture the token *before* the deactivation.
  - A deactivated user's `POST /auth/login` → `401` with the deactivated message; a
    deactivated user's login with a *wrong* password → `401` with the generic message.
  - Last-Owner: demotion → `409`; deactivation → `409`; both succeed once a second
    active Owner exists.
  - `PATCH /auth/password` with the correct current password → `204`, then login with
    the new password succeeds and with the old one fails. Wrong current password →
    `401` and the old password still works.
  - Owner reset via `PATCH /users/:id/password` → the target logs in with the new
    password, not the old.
  - No user response anywhere in the file contains `passwordHash` — asserted on
    `GET /users`, `GET /users/:id`, `POST /users`, and on a transaction's nested
    `recordedBy`.

- **Existing suites** — the `DEFAULT 'active'` on the new column is specifically what
  keeps all four existing e2e specs' raw `INSERT`s working untouched.
  `roles.e2e-spec.ts` never exercises `GET /users`, so making it
  Owner-only breaks nothing there — but confirm that rather than assume it, since it is
  the assumption that would make step 5 look green while shipping a regression.

- **No new integration-layer test** — same reasoning as Phases 3, 4, and 5: nothing here
  is concurrency-sensitive database behavior a mocked repository would misrepresent. The
  last-Owner check is a read-then-write with a theoretical race (two Owners demoting
  each other simultaneously), which at a scale of one small business with at most a
  handful of Owners is not worth a transaction and a row lock. Worth one sentence in the
  code acknowledging it rather than pretending it isn't there.

---

## 6. Rollout order

1. **`common/password.ts`**, with `AuthService.validateUser` and `run-seed.ts` switched
   to it. Pure refactor: the full suite must be green with zero test changes. If it
   isn't, the refactor is wrong, and finding that out here costs nothing.
2. **`users.status`**: enum column, migration, entity, the seed's fourth user, and the
   `auth.service.spec.ts` fixture fix. Nothing reads the column yet.
3. **`AuthService.validateUser` + `JwtStrategy.validate` reject inactive users**, with
   their unit tests. First real behavior change — but no route can deactivate anyone
   yet, so in practice still a no-op against a freshly seeded database (except for the
   new demo user, who is the point).
4. **`UsersService` write methods + `assertOwnerRemains` + `users.service.spec.ts`.**
   Not routed yet; nothing external can reach any of it.
5. **`UsersController` (class-level `@Roles`) + DTOs + `PATCH /auth/password` +
   `users.e2e-spec.ts`.** **This is the feature landing**, and the first step that
   changes an existing route's behavior (`GET /users` closing to Staff).
6. **Frontend**: nav item, routes, `Views.userList` / `userForm` / `account`, the
   `CURRENT_USER` refresh, Store methods.
7. **Documentation** (§4).

Steps 1–4 are individually shippable and, from any client's point of view, no-ops — the
same property Phase 5's rollout had, for the same reason: if step 5 goes wrong,
everything before it can stay.

---

## 7. Explicitly out of scope for Phase 6 (Future)

- **Self-service signup** — still. Phase 3 decided it; an Owner creating accounts is
  the whole model here.
- **Email-based password reset** — there is no mail transport in this project and this
  phase does not add one. The Owner reset (§1) is the recovery path.
- **Forced password change on first login**, password expiry, password history — a state
  machine and a set of columns for a workflow nobody has asked for.
- **A third role, or per-permission granularity** — unchanged from Phase 5 §7. Two
  roles, a decorator, a guard.
- **An audit log of administrative actions** — "who deactivated whom, when" is a
  reasonable thing to want and a genuinely different feature: a new table, a write path
  on every admin action, and a screen. Inventory history is audited because BR-050
  requires it; account changes have no such requirement yet.
- **Rate limiting and account lockout on failed logins** — still out, and worth saying
  why now that it is more tempting: this phase adds a password-verification endpoint
  (`PATCH /auth/password`), which is a second place to guess at a password. But it is a
  place that already requires a valid token, so it is not an anonymous attack surface,
  and rate limiting is a cross-cutting concern (a global guard or middleware, a store,
  a policy) that deserves its own phase rather than a corner of this one.
- **`created_at` / `updated_at` on `users`** — the table has never had them, and
  "account created on" is a nice column on a screen, not a requirement. Adding audit
  timestamps is a reasonable small phase of its own, applied consistently, not a rider
  here. **Done — Phase 7** (`docs/phase-7-plan.md`): `users` and `categories` both
  gained the pair, applied per the mutability rule the whole schema now follows
  (`domain-model.md` §8), not just to `users` alone.
- **Token revocation beyond deactivation** — revoking *a token* (rather than *a person*)
  still needs the server-side state Phase 3 declined, and still has no use case.
- **Q-6, adjustment approval workflow** — still open, still untouched, and explicitly
  not resolved by anything in this phase. An Owner-administered account system is not
  an approval workflow, in the same way a role gate wasn't.
- **Per-role UI beyond the Users nav item and the owner-only actions already hidden** —
  no separate Staff dashboard, no role-specific landing page.

---

## 8. Definition of done

- [ ] `users.status` is a Postgres enum (`'active' | 'inactive'`) with
      `NOT NULL DEFAULT 'active'`, migrated safely against an already-seeded database,
      and the three existing e2e specs' raw `INSERT`s still compile and pass untouched.
- [ ] An Owner can create, edit (name / email / role), deactivate, reactivate, and
      reset the password of any account, entirely through the UI. There is no user
      delete endpoint.
- [ ] Every `/users` route requires the Owner role via a single class-level `@Roles()`,
      and `GET /users` returning `403` for Staff is asserted in a test.
- [ ] A deactivated user cannot log in, **and their existing unexpired token stops
      working on their next request** — both proven by e2e tests, the second one with a
      token captured before deactivation.
- [ ] The deactivated-account login message is distinct from the generic one and is
      returned only after a successful password comparison, with a test that pins the
      ordering.
- [ ] The system cannot be left with zero active Owners: demoting or deactivating the
      last active Owner returns `409`, including when the only other Owner is inactive.
- [ ] Any authenticated user can change their own password by supplying the current
      one; a wrong current password returns `401` and changes nothing.
- [ ] `passwordHash` appears in no response body anywhere, including nested
      `recordedBy` objects — asserted, not assumed.
- [ ] The frontend shows Users in the sidebar for Owners only, guards the owner-only
      user routes, exposes `#/account` to both roles, and refreshes `CURRENT_USER` after
      an Owner edits their own record.
- [ ] `bcrypt` and the cost factor appear in exactly one file.
- [ ] `requirements.md` (FR-063, FR-064), `business-rules.md` (BR-074–078, with BR-073
      amended in place), `product.md` (A-5, §7), `api.md`, `README.md`, and the
      authentication learning note all reflect this phase — and Q-6 is still recorded as
      open.
- [ ] Full backend suite green: unit, integration, and all five e2e specs.
