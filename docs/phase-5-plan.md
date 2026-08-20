# Phase 5 Plan — Role-Based Authorization (Owner vs. Staff)

Status: Phase 5 — Complete
Last updated: 2026-08-20
Scope decided with the project owner: **enforce the `role` field that has been
descriptive-only since Phase 2**, and nothing else. Tightly scoped in the same way
`phase-3-plan.md` was scoped to authentication — one headline change, an explicit
out-of-scope list, no punch-list riding along.

## Why this phase, why now

Every Must and Should requirement is now Done: FR-060 closed in Phase 3, FR-005 in
Phase 4. There is no remaining priority-table gap to work down, so Phase 5 is a
chosen direction rather than the obvious next item — and authorization is the one
that follows most directly from what already exists.

Phase 3 made the system answer *who is this?* (`JwtAuthGuard`, `CurrentUserId` reading
a cryptographically verified `request.user.id`). It deliberately stopped there:
`phase-3-plan.md` §6 lists "role-based access control" as out of scope, and
`product.md` A-5 still reads "fine-grained role-based permissions are deferred; MVP
assumes all authenticated users can perform inventory operations." Meanwhile the
`users.role` column has existed since the very first migration, the seed populates it
with `Owner` and `Staff`, `AuthService.login` returns it in `LoginResult`, and the
frontend renders it in the top-bar user chip (`index.html` ~line 697) — a label that
currently promises a distinction the system does not actually make. A Staff user can
delete a product today.

So this phase closes the gap between what the UI says about a user and what the
server enforces about them, which also resolves **Q-8** ("what user roles exist, even
informally, and do they need to behave differently anywhere in the UI") and moves
**A-5** from "deferred" to "two roles, enforced."

---

## 1. Design decisions

### Exactly two roles: Owner and Staff — no third role, no permission table
`product.md` §3 names exactly two target users: *business owner / manager* (sets up
products and suppliers, monitors) and *stock / inventory staff* (does the day-to-day
receiving, issuing, and correcting). The seed already encodes those two and only
those two. A general permission system — roles table, permissions table, role↔
permission join — would be building for a need nobody has stated, the same reasoning
`phase-3-plan.md` used to reject refresh tokens and `phase-4-plan.md` used to reject
category hierarchy. Two roles, a decorator, and a guard.

### The split follows §3's job descriptions: master data is Owner, stock movement is everyone
The line is drawn where `product.md` already draws it, not invented here:

| Area | Who | Why |
|---|---|---|
| Product create / edit / status / delete | **Owner** | "Manager adds a new product to the catalog" (`product.md` §5 use cases 1–2). Deleting a product is destructive and already guarded by BR-004; it should not also be one mis-click away from any signed-in user. |
| Supplier create / edit / status | **Owner** | Same reasoning, same use-case list. |
| Category create / rename / delete | **Owner** | Master data, and deleting one silently uncategorizes products (`phase-4-plan.md` §1). |
| Stock-in / stock-out / adjustment | **Any authenticated user** | "Staff records a stock-in…" (§5 use cases 3–5). This is the job the product exists to make effortless; gating it would defeat the point. |
| Every read — products, suppliers, categories, transactions, dashboard, `/auth/me` | **Any authenticated user** | §4 user goals are read goals ("know at any moment how much of each product is in stock") and are not attributed to one role. A single-location small team of 1–10 people (A-1) does not need read segmentation. |

### Adjustments stay open to Staff — and Q-6 stays open
Adjustment is the tempting one to lock down, since it can move stock by an arbitrary
delta with no counterparty. It stays open anyway, for two reasons. First, blocking it
would silently answer **Q-6** ("should adjustments require an approval step") in the
affirmative through the back door, when Q-6 asks for a *workflow* (submit → approve),
not a *role gate* — an Owner-only adjustment endpoint is not an approval workflow, it
is just a worse version of one that also stops staff from doing a stocktake. Second,
the controls that make adjustments safe already exist and are unrelated to role:
BR-032 makes a reason mandatory, BR-034/BR-051 make the record immutable, and FR-061
attributes it to the user who did it. Q-6 remains open and out of scope; this phase
must not be read as having resolved it.

### The role is read from the database per request, not carried in the JWT
`AuthService.login` currently signs a payload of `{ sub: user.id }` and nothing else,
with an explicit comment giving the reason: "everything else about the user is looked
up fresh from the database when it's actually needed… so the token itself never goes
stale if a user's name/role changes later." Adding `role` to the payload would be the
cheap route — zero extra queries — but it would contradict that decision in the same
commit that depends on it, and it would mean a user demoted from Owner keeps Owner
powers until their token expires. For an authorization claim, "stale until expiry" is
the wrong default.

So `JwtStrategy.validate` gains a lookup and returns `{ id, role }` instead of
`{ id }`. The cost is one primary-key lookup per authenticated request, which at this
project's scale (A-1: one small business) is not a number worth optimizing against a
correctness property. Two consequences worth naming:

- A role change takes effect on the user's **next request**, not at their next login.
- A token whose user no longer exists now fails with `401` instead of sailing through
  on a valid signature alone. That is a fix, not a regression, but it is a behavior
  change and belongs in the e2e tests.

`CurrentUserId` needs no change — it reads `request.user.id`, which is still there.

### `RolesGuard` is a second global guard, default-open, mirroring `@Public()`
`JwtAuthGuard` is registered as an `APP_GUARD` in `auth.module.ts` and reads
`@Public()` metadata through `Reflector`. `RolesGuard` is built the same way and
registered the same way — a route with no `@Roles()` metadata is allowed for any
authenticated user, exactly as a route with no `@Public()` requires a token. The
alternative (default-closed, every route must declare a role) would mean touching
every controller in the app to say "no change," and would make a newly added route
fail closed with a confusing 403 rather than behaving like its neighbours.

Guard ordering matters and is the one genuinely subtle part: Nest runs global guards
in the order their `APP_GUARD` providers are registered, so `RolesGuard` must be
listed **after** `JwtAuthGuard` in the providers array. Otherwise it runs before
Passport has populated `request.user` and sees no role on every request. There should
be a comment saying so at the registration site, because nothing about the code's
appearance makes the dependency visible.

### `role` becomes a real Postgres enum, with lowercase values
Today `users.role` is `character varying NOT NULL` (`1787122164465-InitSchema.ts`) —
free text. Once it drives authorization, a typo in a seed or a manual `INSERT`
(`'owner '`, `'OWNER'`, `'Manager'`) silently produces a user who can do nothing
Owner-only and gets no error telling them why. Every other closed set in this schema
is a Postgres enum with lowercase values — `products_status_enum` and
`suppliers_status_enum` as `('active', 'inactive')`, `inventory_transactions_type_enum`
as `('stock_in', 'stock_out', 'adjustment')` — so `users_role_enum` as
`('owner', 'staff')` follows the house pattern rather than inventing one, backed by a
`UserRole` enum in `common/enums/user-role.enum.ts` next to the existing
`entity-status.enum.ts` and `transaction-type.enum.ts`.

The lowercase choice has one visible consequence: the stored value stops being the
display value. The seed's `'Owner'`/`'Staff'` become `'owner'`/`'staff'`, and the
frontend's user chip — which currently prints `user.role` raw — needs a small label
map. That is the right side of the trade: the wire format matches the rest of the
schema, and capitalization is a presentation concern.

### No user administration in this phase
There is deliberately no `POST /users`, no `PATCH /users/:id/role`, and no admin
screen. Phase 3 decided there is no self-service signup and `UsersService` is
read-only by design; roles are assigned the same way users are — by the seed, or by a
direct `UPDATE` in the dev database. Adding user management would double this phase's
surface area and pull in questions it doesn't need to answer (can an Owner demote the
last Owner? who creates the first one?). It is listed in §6 as the obvious follow-on.

---

## 2. What's new (backend)

### `UserRole` enum + migration
- `src/common/enums/user-role.enum.ts` — `export enum UserRole { Owner = 'owner', Staff = 'staff' }`.
- `User.role` becomes `@Column({ type: 'enum', enum: UserRole })`.
- New migration `…-AddUserRoleEnum.ts`, following the same
  add-nullable → backfill → constrain shape `AddAuthToUsers1787194988413` used so it
  is safe against an already-seeded database rather than only an empty one:
  1. `CREATE TYPE "public"."users_role_enum" AS ENUM('owner', 'staff')`
  2. `UPDATE "users" SET "role" = lower("role")` — normalizes the existing
     `'Owner'`/`'Staff'` rows.
  3. `UPDATE "users" SET "role" = 'staff' WHERE "role" NOT IN ('owner', 'staff')` —
     anything unrecognized lands on the *less* privileged role, so a bad row can never
     be silently promoted by a migration.
  4. `ALTER TABLE "users" ALTER COLUMN "role" TYPE "public"."users_role_enum" USING "role"::"public"."users_role_enum"`
  - `down()` reverses to `character varying` and drops the type.
- `run-seed.ts` — the three demo users switch to `UserRole.Owner` / `UserRole.Staff`.
  Alex Rivera stays the Owner, Jordan Lee and Sam Patel stay Staff, so the README's
  sign-in table stays true except for the displayed casing.

### `@Roles()` decorator
`src/common/decorators/roles.decorator.ts` — `SetMetadata`-based, the same shape as
`public.decorator.ts`, exporting `ROLES_KEY` and `Roles(...roles: UserRole[])`.

### `RolesGuard`
`src/auth/roles.guard.ts`:

```
canActivate(context):
  required = reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [handler, class])
  if (!required || required.length === 0) return true      // default-open
  const { user } = context.switchToHttp().getRequest()
  if (!user) return false                                   // belt-and-braces; JwtAuthGuard ran first
  if (required.includes(user.role)) return true
  throw new ForbiddenException('This action requires the Owner role.')
```

Throwing an explicit `ForbiddenException` rather than returning `false` is worth the
extra line: Nest's default for `false` is a generic "Forbidden resource," and a
signed-in Staff user who clicks something they shouldn't see deserves a message that
says why. `AllExceptionsFilter` passes `HttpException`s through unchanged, so this
arrives as a clean `403`.

Registered in `auth.module.ts` as a second `APP_GUARD`, after `JwtAuthGuard`.

### `JwtStrategy.validate` gains the role lookup
Injects `UsersService`, looks the user up by `payload.sub`, and returns
`{ id: user.id, role: user.role }`. A missing user throws `UnauthorizedException`
(Passport turns a thrown error here into a 401, which is the right code — the token
no longer identifies anybody).

No module wiring is needed for this: `AuthModule` already imports `UsersModule`, and
`UsersModule` already exports `UsersService` ("AuthModule reuses this for
GET /auth/me"). The strategy just injects what is already available to it.

`validate` becomes `async` as a result, which the existing `jwt.strategy.spec.ts` has
to follow — it currently constructs `new JwtStrategy(configService)` with one argument
and asserts `validate({ sub: 42 })` equals `{ id: 42 }` synchronously. Both change.

### Routes that gain `@Roles(UserRole.Owner)`

| Controller | Routes |
|---|---|
| `ProductsController` | `POST /products`, `PATCH /products/:id`, `PATCH /products/:id/status`, `DELETE /products/:id` |
| `SuppliersController` | `POST /suppliers`, `PATCH /suppliers/:id`, `PATCH /suppliers/:id/status` |
| `CategoriesController` | `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id` |

Applied per-route, not per-controller, precisely because each of those controllers
also serves `GET` routes that stay open to everyone — a class-level `@Roles()` would
lock reads too. `InventoryController`, `DashboardController`, `UsersController`, and
`AuthController` get no `@Roles()` at all and are unchanged.

---

## 3. Frontend changes

The server is the enforcement point; everything here is presentation. A Staff user
who edits the DOM or calls the API directly gets a `403`, and that is the design —
the UI's job is to not offer actions that will fail.

- **`Auth.isOwner()`** — one helper reading `CURRENT_USER.role === 'owner'`, defined
  next to `CURRENT_USER` (`index.html` ~line 314) so there is a single place the
  string literal appears. `CURRENT_USER` is set from the login response and held in
  memory only (no `localStorage`, per Phase 3), so it can never be a stale role from a
  previous session.
- **Role label map** — `{ owner: 'Owner', staff: 'Staff' }`, used by the user chip in
  `shellTemplate()` where `user.role` is currently printed raw.
- **Hide, don't disable** — the "New product" / "New supplier" / "Manage categories"
  buttons, the Edit and Delete actions on `Views.productDetail` and
  `Views.supplierDetail`, and the activate/deactivate controls disappear for Staff.
  A disabled-with-tooltip treatment would advertise capabilities a Staff user can
  never have; the app's existing disabled-with-explanation pattern (Stock In/Out on
  an inactive product, Q-UI-1) is for states that *can* change, which is a different
  thing.
- **One route guard, not one per view** — `renderApp()` already gates the whole shell
  on `ACCESS_TOKEN` rather than guarding each view, with a comment explaining why.
  The role check goes in the same place: a small set of owner-only routes
  (`#/products/new`, `#/products/:id/edit`, `#/suppliers/new`, `#/suppliers/:id/edit`,
  `#/categories`) redirects to `#/dashboard` with a toast for a Staff user who arrives
  by typed URL or stale bookmark.
- **`403` handling in `Store._request`** — currently only `401` is special-cased
  (discard token, bounce to login). A `403` must explicitly **not** do that: the
  session is fine, the action isn't allowed. It falls through to the existing
  `throw new Error(message)` path, which the forms and wizards already surface — the
  change is a comment at the `401` branch making the distinction explicit, so nobody
  later "tidies" the two status codes into one condition.

---

## 4. Documentation updates

1. **`requirements.md`** — new **FR-062, "Role-based authorization"** under User
   Attribution (Must), describing the Owner/Staff split, with the FR-060 note amended
   to point at it. FR-001/002/003/006 and FR-010/011/013 gain an "Owner only" note in
   their Notes column.
2. **`business-rules.md`** — a new **Authorization** section:
   - **BR-070** — two roles exist, Owner and Staff; every user has exactly one.
   - **BR-071** — creating, editing, deactivating, or deleting a Product, Supplier, or
     Category requires the Owner role.
   - **BR-072** — recording a stock-in, stock-out, or adjustment requires only an
     authenticated user, of either role. Explicitly notes that this is *not* a
     resolution of Q-6.
   - **BR-073** — reads are available to both roles.
   - The "Rules Explicitly Deferred" list keeps its Q-6 line unchanged.
3. **`product.md`** — A-5 rewritten from "fine-grained role-based permissions are
   deferred" to record what now exists and what is still deferred (per-permission
   granularity, user management). **Q-8** marked `[Resolved 2026-08-20, Phase 5]`.
   Q-6 stays open, untouched.
4. **`api.md`** — an "Owner only" marker on the ten routes listed in §2, across its
   Categories, Suppliers, and Products sections, plus a note in the preamble that a
   `403` means the wrong role while a `401` means no valid token. Its title
   ("API Documentation — Phase 3") needs bumping too.
5. **`docs/learning-notes/authentication-and-guards.md`** — a new section on
   authorization as distinct from authentication: multiple `APP_GUARD` providers,
   why registration order is load-bearing here, and why `@Roles()` is default-open
   while the absence of `@Public()` is default-closed. This file is the phase's
   learning-notes home; no new note file is needed.
6. **`README.md`** — the sign-in table's Role column updated to the stored values, and
   a line noting that only `alex@example.com` can manage products, suppliers, and
   categories, so the demo doesn't look broken to someone signed in as Jordan.

---

## 5. Testing plan

- **Unit — `roles.guard.spec.ts`** (new): no `@Roles()` metadata → allows; metadata
  matching `request.user.role` → allows; metadata not matching → throws
  `ForbiddenException`; missing `request.user` → denies rather than throwing a
  `TypeError`. Mocked `Reflector` and `ExecutionContext`, the same way
  `all-exceptions.filter.spec.ts` mocks its host.
- **Unit — `jwt.strategy.spec.ts`** (existing, extended): `validate` returns
  `{ id, role }` from the looked-up user, and throws `UnauthorizedException` when the
  user no longer exists.
- **E2E — `test/roles.e2e-spec.ts`** (new, following `auth.e2e-spec.ts`'s setup
  verbatim: the `process.env.DB_DATABASE = 'smart_inventory_e2e'` line before the
  imports, the same global pipes/filter/interceptor wiring, `TRUNCATE … RESTART
  IDENTITY CASCADE` in `beforeEach`, users inserted with real bcrypt hashes). Seeds one
  Owner and one Staff, logs both in, then:
  - Staff `POST /products` → `403`; Owner `POST /products` → `201`. Same pair for
    `PATCH /products/:id/status`, `DELETE /products/:id`, `POST /suppliers`,
    `PATCH /suppliers/:id/status`, and `POST /categories`.
  - **Staff `POST /products/:id/stock-out` → `201`.** This is the most important test
    in the file: it proves the phase didn't over-lock the system and break the exact
    workflow the product exists for. A regression here would be worse than a missing
    403.
  - Staff `GET /products`, `GET /dashboard/summary` → `200`.
  - A `403` response body carries the Owner-role message, not a generic "Forbidden
    resource" — i.e. the explicit `ForbiddenException` is actually reaching the client.
  - A valid, unexpired token whose user row has been deleted → `401` (the
    `JwtStrategy` lookup's new behavior, asserted rather than discovered later).
- **Existing suites** — `app.e2e-spec.ts` seeds its single user as
  `('E2E User', 'Staff', …)` (line ~72) and then drives product and supplier writes as
  that user. It must become `'owner'`, or the whole file starts failing with `403` —
  for the right reason, but in the wrong place. `auth.e2e-spec.ts`'s
  `'Auth Test User', 'Staff'` insert only exercises `/auth/login` and `/auth/me`, so it
  needs only the lowercase change, not a promotion. Both edits are part of step 4, not
  an afterthought.
- **No new integration-layer test** — same reasoning as Phases 3 and 4: nothing here
  is concurrency-sensitive database behavior that a mocked repository would
  misrepresent.

---

## 6. Rollout order

1. `UserRole` enum, `User` entity column type, migration, seed update. Nothing
   enforces anything yet; the app behaves exactly as before with tidier data.
2. `JwtStrategy.validate` role lookup + its unit tests. `request.user` now carries a
   role that nothing reads yet.
3. `@Roles()` decorator + `RolesGuard` + `roles.guard.spec.ts`, registered as the
   second `APP_GUARD`. Still no behavior change — no route declares a role.
4. `@Roles(UserRole.Owner)` on the ten routes + `roles.e2e-spec.ts` + the
   `app.e2e-spec.ts` seed fix. **This is the feature landing**, and it is the first
   step that can break an existing client.
5. Frontend: `Auth.isOwner()`, label map, hidden actions, route guard, the `403`
   comment.
6. Documentation (§4).

Steps 1–3 are individually shippable no-ops, which is the point: if something in step
4 goes wrong, everything before it can stay.

---

## 7. Explicitly out of scope for Phase 5 (Future)

- **User management** — no signup, no admin screen, no `PATCH /users/:id/role`. Roles
  are set in the database, as users already are.
- **A third role or per-permission granularity** — no "can_delete_products" style
  permission table (§1).
- **Q-6, adjustment approval workflow** — explicitly *not* resolved by this phase; see
  §1.
- **Per-role UI beyond hiding owner-only actions** — no separate Staff dashboard, no
  role-specific landing page. Both roles see the same screens minus the actions Staff
  can't perform.
- **Token revocation / forced re-login on role change** — the role lookup already
  makes a demotion take effect on the next request, which is the property that
  mattered; Phase 3's "no revocation list" decision stands otherwise.
- **Rate limiting, audit log of denied attempts, account lockout** — adjacent
  security work, none of it asked for, none of it required by the two-role split.

---

## 8. Definition of done

- [x] `users.role` is a Postgres enum (`'owner' | 'staff'`), migrated safely from the
      existing free-text column including already-seeded data.
- [x] `RolesGuard` is registered globally after `JwtAuthGuard`, is default-open for
      routes without `@Roles()`, and returns a `403` with a role-specific message.
- [x] `request.user` carries a role read from the database on every authenticated
      request; a token for a deleted user is rejected with `401`.
- [x] The ten master-data write routes require Owner; stock-in, stock-out,
      adjustment, and every read do not — both directions proven by e2e tests.
- [x] The frontend hides owner-only actions from Staff, redirects owner-only routes,
      and does not log a user out on a `403`.
- [x] `requirements.md` (FR-062), `business-rules.md` (BR-070–073), `product.md` (A-5,
      Q-8), `api.md`, `README.md`, and the authentication learning note all reflect
      the split — and Q-6 is still recorded as open.
- [x] Full backend suite green, including the extended `app.e2e-spec.ts`.
