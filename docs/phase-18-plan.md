# Phase 18 Plan — Structured Stock-Out Reason Categories (issue #8, resolving Q-4)

Status: Phase 18 — Implemented on branch `1102huynh/issue-8-model-sale-concept`
(all steps done and verified locally — backend `nest build` + `lint:check` clean,
`npm test` 16 suites / 167 tests, `npm run test:e2e` 7 suites / 107 tests, frontend
`npm test` 28 tests; a reseed of the dev database with the new column populated; a
browser walk of the stock-out wizard is the one check left to the reviewer).
Last updated: 2026-09-07

**[2026-09-07, on implementation]**
- **The four forks were decided with the project owner up front** (depth, required?,
  vocabulary, resolve-Q-4) — see §1. All four took the recommended option.
- **`reasonCategory` is a real per-table Postgres enum + column**, not a
  frontend-only dropdown like the adjustment reason picker. Q-4 asks whether a
  stock-out should *model* a sale; a value you can filter and report on is the only
  answer that does. Migration `1787930000000-AddStockOutReasonCategory`.
- **It stays optional.** FR-021 ("…and optional reason") is a Must and is unchanged.
  The new **FR-025** (Should) adds the categorisation beside it; **BR-023** is the
  rule. No existing row, seed, test, or API caller had to change to keep working.
- **The vocabulary is seven values**: `sale`, `internal_use`, `damaged`, `lost`,
  `expired`, `return`, `other`. `other` requires the free-text note (BR-023).
- **Q-4 is resolved.** "Sale" is modelled as a reason category — no customer, no
  price (Q-1 already resolved "no pricing"), no `Sale`/`Order` entity. A full Sale
  entity stays Future (§7), gated on a real need for customer / line-item records —
  the same shape as Q-1's resolution.

Scope decided with the project owner: **give a stock-out an optional structured
reason from a fixed set, the way the issue describes ("structured reason categories
for stock-out, like adjustments already have") — resolving product.md Q-4 in its
lighter form — and nothing else.** Scoped the same way `phase-17-plan.md` was scoped
to three pickers: one headline change, an explicit out-of-scope list (§7), no
punch-list riding along.

## Why this phase, why now

`product.md` Q-4 has been open since Phase 5 and named "still open" in every phase
cross-reference since (7, 9, 10, 11, 12, 14, 15, 16, 17). The question — does a
stock-out model only internal removal, or also a *sale* (customer, price)? — has a
tractable first answer that the issue itself spells out:

> Q-1 already resolved 'no pricing', so the lighter form — structured reason
> categories for stock-out, like adjustments already have (`REASON_OPTIONS`) — is the
> tractable first step. Would add FR/BR.

Nothing forces it now beyond that it is the oldest open question and the cheapest it
will ever be to close: `inventory_transactions` already carries a free-text `reason`
for stock-out, the enum-column pattern is well-trodden (`users_role_enum`,
`users_status_enum`, `inventory_transactions_type_enum`), and the stock-out wizard
already has a reason field to upgrade. Re-deriving this against a schema that has by
then grown other stock-out concerns is a phase; applying it now is an afternoon.

**This phase changes the domain documents, unlike Phases 14–17.** It adds one FR
(FR-025, Should), one BR (BR-023), resolves Q-4, and adds a nullable enum column with
a migration. It is a product-level edit in the register of Phase 9's FR-065 and Phase
12's FR-066 — §5's use case 4 ("Staff records a stock-out when goods leave (sale,
consumption, removal)") gains the ability to say *which*; §4 and §7 are untouched
except that §7's "Sale/Order entity" line gets a sharper trigger.

---

## 1. Design decisions (the four forks)

### Fork A — how structured. **Chosen: a real enum column + migration**

- **A1 — a dedicated nullable `reason_category` enum column** on
  `inventory_transactions`, validated by a backend `StockOutReason` enum, with the
  free-text `reason` kept for the detail. The value round-trips through the API and is
  queryable/reportable. Needs a migration. **Recommended, and chosen** — Q-4 is about
  *modelling* the distinction, and a stored, constrained field is the only thing that
  models it. The adjustment reason picker (frontend-only `REASON_OPTIONS`, writing a
  label string into `reason`) is admittedly cosmetic; doing it properly here is the
  point of the phase.
- **A2 — a frontend-only dropdown** that writes the chosen label into the existing
  `reason` text column, exactly like the adjustment picker. No migration, no backend
  enum. Rejected: it adds no server-side structure, so it does not actually resolve
  Q-4 — it just makes the free-text field easier to fill.

### Fork B — required or optional. **Chosen: optional, a new Should FR beside FR-021**

- **B1 — optional.** FR-021 ("…and optional reason") stays a Must, unchanged. A new
  **FR-025** (Should) covers the categorisation; **BR-023** is the rule. Existing
  rows, seeds, tests, and API callers are unaffected — the column is nullable with no
  default and no backfill. **Recommended, and chosen.**
- **B2 — mandatory.** Every new stock-out must carry a category; FR-021 is amended
  (the way Phase 12 amended BR-072). Rejected: a bigger domain-doc change and a
  harder API contract for no proportionate gain — a shop that does not care to
  categorise should not be blocked from recording that stock left.

### Fork C — the vocabulary. **Chosen: seven values**

`sale`, `internal_use`, `damaged`, `lost`, `expired`, `return`, `other`.

- `sale` is the lightest possible expression of "modelling a sale" — no customer, no
  price. `return` is "returned to supplier". `other` is the escape hatch and
  **requires** the free-text note (BR-023), mirroring the adjustment picker's "Other".
- Rejected: a minimal `sale / damaged / lost / other`. The four extra values
  (`internal_use`, `expired`, `return`) are ordinary small-business stock-out reasons
  and cost nothing to include; a too-small set pushes real cases into `other`.

### Fork D — resolve Q-4, or leave it open. **Chosen: resolve it**

- Record in `product.md` §10 that **Q-4 is resolved**: "sale" is a reason category;
  there is no `Sale`/`Order`/customer/price entity, and a full one stays Future (§7)
  with a concrete trigger (a real need to record customers or line items). Same shape
  as Q-1's "no pricing" resolution — a decision to model the light form and defer the
  heavy one, not a deferral of the whole question.
- Rejected: shipping the categories but leaving Q-4 "open (partial)". The question as
  asked — "does stock-out also model a sale, i.e. do we need a Sale/Order entity?" —
  now has a definite answer: no, a category is enough. Leaving it nominally open
  would just carry a resolved question forward in every future cross-reference.

---

## 2. What's new (backend)

No new dependency, no new module, no new route. One new enum, one column, one
migration; one DTO and one service `values` type gain a field.

### `StockOutReason` — `backend/src/common/enums/stock-out-reason.enum.ts` (new)

String enum, top-of-file domain-doc comment, in the style of `transaction-type.enum.ts`:
`SALE='sale'`, `INTERNAL_USE='internal_use'`, `DAMAGED='damaged'`, `LOST='lost'`,
`EXPIRED='expired'`, `RETURN='return'`, `OTHER='other'`.

### `InventoryTransaction` — `backend/src/inventory/inventory-transaction.entity.ts`

- New column: `@Column({ name: 'reason_category', type: 'enum', enum: StockOutReason,
  nullable: true }) reasonCategory: StockOutReason | null;`
- New class-level `@Check(\`type = 'stock_out' OR reason_category IS NULL\`)` — BR-023,
  the "a category only makes sense on a stock-out" guard, the same shape as the
  existing `type = 'stock_in' OR supplier_id IS NULL`.

### Migration — `1787930000000-AddStockOutReasonCategory.ts` (new)

`CREATE TYPE inventory_transactions_reason_category_enum`, `ADD COLUMN reason_category`
(nullable, **no default, no backfill** — a stock-out recorded before this phase or
without a category legitimately has none), `ADD CONSTRAINT
CHK_inventory_transactions_reason_category_stock_out`. `down` reverses all three. The
test database (`test-data-source.ts`, `synchronize: true`) builds the column and
constraint from the entity decorators instead — the same three-registries split the
entity's `@Index` comment already documents, and the reason the generated `@Check`
name there differs from the hand-written one here.

### `CreateStockOutDto` — `backend/src/inventory/dto/create-stock-out.dto.ts`

- `@IsOptional() @IsEnum(StockOutReason) reasonCategory?: StockOutReason;`
- `reason` becomes conditionally required: `@ValidateIf(o => o.reasonCategory ===
  StockOutReason.OTHER || o.reason !== undefined)` + `@IsString()` + `@IsNotEmpty()`
  — mandatory and non-empty when the category is `other` (BR-023), and rejecting an
  empty-string `reason` whenever one is supplied.

### `InventoryService` — `backend/src/inventory/inventory.service.ts`

- `insertTransaction`'s `values` type and `repo.create(...)` gain `reasonCategory`.
- `recordStockOut` passes `dto.reasonCategory ?? null`; the stock-in and adjustment
  call sites pass `null`.
- **No read-path change**: the two history queries `getMany()` full entities, so
  `reasonCategory` serialises onto `GET /products/:id/transactions` and
  `GET /inventory-transactions` with no query edit.

### Seed — `backend/src/database/seeds/run-seed.ts`

The `TRANSACTIONS` tuple gains a trailing `reasonCategory` slot (`StockOutReason |
null`, null on every stock-in / adjustment). Seeded stock-outs get a realistic spread
— mostly `sale`, plus one each of `expired`, `damaged`, `internal_use`, and an
`other` with its note — so the History screen shows the feature working on a fresh
`npm run seed`.

---

## 3. Frontend changes

No new module, no CSS. The stock-out branch of the wizard's shared reason field
becomes a picker + note; the two history views show the category.

### `frontend/ui.js`

New `UI.STOCK_OUT_REASONS` (the `[value, label]` list, mirroring `StockOutReason`) and
`UI.stockOutReason(value)` (value → label). Lives on `UI` because three call sites in
two view files share it — the wizard renders the `<option>`s, both history rows turn a
stored value back into a label.

### `frontend/config.js` — `normalizeTx`

Adds `reasonCategory: t.reasonCategory || null` to the normalised transaction.

### `frontend/api.js` — `Store.recordStockOut`

Accepts `reasonCategory`, sends it as `reasonCategory: reasonCategory || undefined`.

### `frontend/views/transactions.js`

- **`transactionWizard`** — `inOutFields()`'s stock-out branch renders a
  `<select id="f-reason-cat">` (default `— Optional: select a reason —`) above the
  free-text `#f-reason` input; the note's label gains a `*` and its placeholder
  changes to "Describe the reason" when the category is `other`. `readForm()` reads
  `#f-reason-cat` into `form.reasonCategory` for stock-out; `validate()` requires the
  note when the category is `other` (BR-023); the existing `#f-reason-cat` `change`
  handler (built for the adjustment picker) already re-renders so the required marker
  tracks the selection. `reviewHtml()` shows the category label, with the note
  appended (`Sale — cleared the last two cases`). The confirm handler passes
  `reasonCategory: form.reasonCategory`; "Record Another" already clears it.
- **`historyView`** — `rowHtml()`'s "Supplier / Reason" cell, for a non-stock-in row,
  shows the category label with the note appended when present, falling back to the
  note alone for adjustments and pre-Phase-18 stock-outs.

### `frontend/views/products.js`

`historyRow()` gets the same category-aware "Supplier / Reason" cell as `historyView`.

**Explicitly not in this phase's frontend:** a picker anywhere else (the adjustment
reason picker keeps its own frontend-only `REASON_OPTIONS`), a required category, a
per-category filter on the History screen, or any customer / price field.

---

## 4. Documentation updates

1. **`requirements.md`** — new **FR-025** "Categorise a stock-out" (Should) in the
   Stock Out section; FR-021's Notes cell updated ("Q-4: sale vs. generic removal" →
   "Q-4 resolved (Phase 18); category is optional, see FR-025"); a
   `## Stock-Out Reason Categories (Phase 18 — FR-025, a Should)` note in the register
   of Phase 9's FR-065 note; the Cross-Reference block gains
   `FR-025 (stock-out reason) → BR-023 → Inventory Transaction` and FR-021's line
   gains BR-023.
2. **`business-rules.md`** — new **BR-023** "Stock-out reason category" under Stock
   Out: optional; the seven-value closed set; `other` requires the note; meaningful
   only on a stock-out (the DB `@Check`); immutable with the row (BR-051). BR-050's
   "adjustments additionally record the reason" line notes a stock-out may too. A
   `[2026-09-07, Phase 18]` note — the first *with* a new BR since Phase 12.
3. **`domain-model.md`** — §3 the "Sale / Order — Not included (Future)" row updated
   (Q-4 resolved toward a reason category; a full Sale entity still Future). §4
   Inventory Transaction: "optional reason for stock-out" → "optional reason and
   reason category for stock-out". §6 invariants: "A Stock-Out may carry an optional
   reason category from a fixed set; no other transaction type may. (BR-023)".
4. **`api.md`** — title/status → Phase 18. `POST /products/:id/stock-out` body
   `{ quantity, occurredAt, reason? }` → `{ quantity, occurredAt, reason?,
   reasonCategory? }`; the seven values listed; `400` when `reasonCategory` is out of
   set or is `other` with no `reason`; a line that `reasonCategory` now appears on
   `InventoryTransaction` in the two history reads.
5. **`product.md`** — §10 **Q-4 → `[Resolved 2026-09-07, Phase 18]`** with the
   reasoning. §11 cross-reference entry in the Phase 9 / 12 register (a product-level
   edit: §5 use case 4 gains detail, §4 unchanged, §7's Sale/Order line gets a
   sharper trigger, §10 Q-4 resolved; Q-7 remains open).
6. **`architecture-observations.md`** — new Phase 18 section: the enum + column +
   `@Check`; the three-registries note (migration for dev/prod, entity decorator for
   the `synchronize: true` test DB, seed tuple extended); **no backfill** — pre-Phase-18
   stock-out rows keep `reason_category = NULL` ("unspecified").
7. **`README.md`** — Current phase → Phase 18; the stock-out reason categories in a
   sentence; **there is a migration this phase** (`AddStockOutReasonCategory`), unlike
   Phases 14–17.

No learning note — the enum-column pattern is already covered by the Phase 5/6
migration notes, and Phases 16/17 each touched at most one note.

---

## 5. Testing plan

- **Integration — `inventory.service.integration.spec.ts`** (real Postgres): a
  stock-out with `reasonCategory: SALE` reads back with it (via the service return and
  a fresh `findOneByOrFail`); a stock-out with none reads back `null`; a raw `INSERT`
  of a `stock_in` row carrying `reason_category` is rejected by the DB `@Check`.
- **E2E — `roles.e2e-spec.ts`**: `POST /products/:id/stock-out` with
  `reasonCategory: 'sale'` → `201`, and the value appears on the
  `GET /products/:id/transactions` row; `'giveaway'` → `400`; `'other'` with no
  `reason` → `400`, with a `reason` → `201`; no category → `201` and
  `reasonCategory: null` (FR-021 regression guard).
- **Existing specs unedited** — `app.e2e-spec.ts`'s stock-in→stock-out→history round
  trip and every other stock-out case still pass; the additive nullable column changes
  no existing response.
- **Frontend — `frontend/test/stock-out-reason.test.js` (jsdom, new):** the wizard
  renders `#f-reason-cat` with exactly the seven options; choosing `other` marks the
  note required and blocks an empty submit; `other` + note advances to review showing
  `Other — <note>` and submits `reasonCategory` + `reason`; `sale` with no note
  advances and submits; no category still records (FR-021).
- **Manual smoke walk**, both roles, frontend on `serve.js` + backend on `:3000`,
  seeded DB:
  - **Stock Out → Sale**: pick "Sale", leave the note blank → Review shows "Sale" →
    Confirm. Inventory History and the product's history both show "Sale".
  - **Stock Out → Other**: pick "Other", leave the note blank → inline error, does not
    advance; add a note → saves; history shows "Other — <note>".
  - **Stock Out, no category**: leave the picker on its default → still saves; history
    shows the note or "—".
  - **Regression**: recording an Adjustment still shows its own unchanged reason
    picker; the History type filter and product typeahead still work; a fresh login
    still fills the product-form category dropdown.

---

## 6. Rollout order

Leaves-first, bootable at every step, in the manner of Phases 11–17.

1. **`StockOutReason` enum + entity column + `@Check` + migration**, plus the
   integration cases. Individually shippable: an additive nullable column with a DB
   guard and no caller yet.
2. **DTO + service** — accept and persist `reasonCategory`; the e2e cases.
3. **`run-seed.ts`** — the tuple slot and realistic values.
4. **`frontend` — `UI.STOCK_OUT_REASONS`, `normalizeTx`, `api.js`** (no visible change
   yet).
5. **`views/transactions.js`** — the wizard picker + the History cell;
   `stock-out-reason.test.js`.
6. **`views/products.js`** — the product-history cell.
7. **The manual smoke walk** (§5).
8. **Documentation** (§4).

If cut short, stop after step 1 or 2 — the app is shippable with no visible change and
an unused-but-valid API field. Stopping mid-frontend (5–6) leaves one history view
showing the category and the other not, which is coherent but half-done.

---

## 7. Explicitly out of scope for Phase 18 (Future)

- **A `Sale` / `Order` entity** — customer, line items, per-sale price. The heavy form
  of Q-4. **Trigger:** a real need to record *who* bought something or to itemise a
  single outbound movement — neither of which `product.md` §3's "1–10 people" shop or
  §8's "no CRM, no POS" has asked for. `sale` as a reason category is the answer until
  then.
- **A required category** / amending FR-021 — see Fork B.
- **A per-category filter or breakdown on the Inventory History screen or the
  dashboard** — a reasonable follow-on (the data is now there), not ridden along here.
  The History `?type=` filter is unchanged.
- **A category on adjustments or stock-in** — the DB `@Check` structurally forbids it;
  adjustments keep their own frontend-only `REASON_OPTIONS`.
- **Backfilling `reason_category` on historical stock-outs** — they are immutable
  (BR-051) and their category is genuinely unknown; `NULL` says exactly that.
- **Q-7 (multi-location)** — untouched, as in every phase since 5.
- The standing parked items — the throttle store (issue #11), the `audit_events`
  retention policy (issue #12), the `mockFetch` / `?state=` scaffolding (issue #10),
  `DashboardService`'s whole-catalogue read (issue #9) — all still parked.

---

## 8. Definition of done

- [x] A stock-out can carry an optional `reasonCategory` from the fixed set
      {`sale`, `internal_use`, `damaged`, `lost`, `expired`, `return`, `other`};
      `other` requires the free-text `reason` note (BR-023). FR-021 is unchanged — no
      category is still a valid stock-out.
- [x] `reasonCategory` is a real nullable per-table Postgres enum column on
      `inventory_transactions`, added by `1787930000000-AddStockOutReasonCategory`
      with **no backfill**, and guarded by a DB `@Check` that only a stock-out row may
      carry one. The test DB builds the same from the entity decorators.
- [x] The value round-trips: `POST /products/:id/stock-out` accepts it and returns it,
      and it appears on both history reads — proven by an integration spec and an e2e
      spec. An out-of-set value or `other` with no note is `400`.
- [x] The stock-out wizard has a reason-category picker; the note becomes required for
      "Other". The Inventory History screen and the product-detail history both show
      the category (with the note appended). Covered by
      `frontend/test/stock-out-reason.test.js`.
- [x] **Q-4 is resolved** in `product.md` §10 — "sale" is a reason category, no
      Sale/Order entity; the full entity stays Future in §7 with a trigger.
- [x] One new **FR-025** (Should) and one new **BR-023**; `domain-model.md` §3/§4/§6,
      `api.md`, `architecture-observations.md`, and `README.md` updated; every fork
      (A depth, B required?, C vocabulary, D resolve-Q-4) recorded either way in §1.
- [x] Full backend suite green — `nest build`, `lint:check`, `npm test` (16/167),
      `npm run test:e2e` (7/107) — and the frontend `node --test` suite green (28).
