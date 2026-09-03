# Product Definition — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-24

## 1. Product Vision

Smart Inventory Manager is a small, focused inventory tracking system that gives a small
business an accurate, always-current view of what stock it has, where it came from, and
where it went — replacing spreadsheets and paper logs with a single source of truth.

The product's value is not in enterprise inventory features (multi-warehouse, batch/lot
tracking, procurement workflows), but in making the basics — knowing current stock,
recording every movement, and catching low stock before it becomes a stockout —
reliable and effortless for a small team.

## 2. Problem Statement

Small businesses commonly track inventory using spreadsheets, notebooks, or memory. This
leads to:

- No reliable, real-time view of current stock per product.
- No record of *why* stock changed (who sold it, who received it, what was lost/damaged).
- Stockouts discovered only when a customer asks for an item that isn't there.
- Overstocking because nobody has visibility into what's already on hand.
- No accountability — mistakes and discrepancies can't be traced back to a transaction.

The product solves this by giving small businesses a lightweight, purpose-built system to
record every stock movement and always know current stock and stock health at a glance.

## 3. Target Users

- **Business owner / manager** — sets up products and suppliers, monitors stock levels and
  low-stock alerts, wants a quick overview (dashboard) without digging through spreadsheets.
- **Stock / inventory staff** — performs the day-to-day work: receiving goods (stock-in),
  recording stock leaving (stock-out), and correcting counts (adjustment).

These are small teams (assumed 1–10 people), typically operating a **single location**
(see Assumptions). The system does not target large retail chains, distributors with
complex logistics, or multi-warehouse operations.

## 4. User Goals

- Know, at any moment, how much of each product is currently in stock.
- Record stock received from suppliers quickly and accurately.
- Record stock leaving (sold, used, removed) quickly and accurately.
- Correct discrepancies (damage, loss, miscounts) with a clear, traceable reason.
- Be alerted when a product's stock is running low, before it runs out.
- See a quick overview of inventory health without manual reporting.
- Trust that historical records are accurate and cannot be silently altered.
- Know who changed what, and when — for accounts and catalog data, not just stock.
  [Added 2026-08-25, Phase 9]

## 5. Core Use Cases

1. Manager adds a new product to the catalog.
2. Manager adds a new supplier.
3. Staff records a stock-in when goods arrive from a supplier.
4. Staff records a stock-out when goods leave (sale, consumption, removal).
5. Staff records an adjustment after a physical stock count reveals a discrepancy.
6. Manager checks current stock for a specific product.
7. Manager reviews the transaction history of a product (or of the whole inventory).
8. Manager reviews the list of products currently low on stock.
9. Manager opens the dashboard to get a quick health overview of the inventory.
10. An Owner reviews the audit log after a colleague reports they cannot sign in.
    [Added 2026-08-25, Phase 9]
11. Staff record a stocktake correction; an Owner reviews and approves it before stock
    changes. [Added 2026-09-03, Phase 12 — resolves Q-6]

## 6. Product Scope

In scope for the product (not necessarily MVP — see below):

- Product catalog management
- Supplier management
- Stock-in, stock-out, and inventory adjustment recording
- Current stock tracking (derived from transactions)
- Full inventory transaction history
- Low-stock detection
- Dashboard summary view

## 7. MVP Scope

See `requirements.md` for the itemized functional requirements and their priority
(Must / Should / Future), and `business-rules.md` FR/BR cross-references.

**Must Have (MVP core):**
- Product management (create, edit, activate/deactivate, list/view)
- Stock-in recording
- Stock-out recording
- Inventory adjustment recording
- Current stock tracking (derived, always accurate)
- Inventory transaction history (immutable, per product and global)
- Low-stock detection (per-product threshold)

**Should Have (near-term, not blocking MVP):**
- Supplier management (linked to stock-in)
- Dashboard summary
- Product categories
- Adjustment approval — a Staff-initiated adjustment is a request an Owner approves or
  rejects before it changes stock; an Owner's own adjustment is recorded immediately
  [Added 2026-09-03, Phase 12 — resolves Q-6; see `requirements.md` FR-066,
  `business-rules.md` BR-085–089]

**Future (explicitly postponed):**
- Multi-location / multi-warehouse inventory
- Purchase order workflow (request → approve → receive)
- Barcode / QR scanning
- Batch, lot, and expiry-date tracking
- Multi-unit conversion (e.g., box ↔ piece)
- Per-permission access control beyond the two-role (Owner/Staff) split [rewritten
  2026-08-21, Phase 6: "Role-based access control beyond basic user attribution" no
  longer means anything after Phase 5 (the role split) and Phase 6 (Owner-administered
  accounts) — this names what's actually still future instead]
- **General** approval workflows — approval on any write other than a Staff-initiated
  adjustment (stock-in, stock-out, catalog and user changes), configurable approver
  chains, magnitude thresholds [narrowed 2026-09-03, Phase 12: adjustment approval
  itself has shipped (see Should Have above and Q-6); what stays Future is approval
  *generalized* beyond that one case — `docs/phase-12-plan.md` §7]
- Pricing, sales, invoicing, and accounting integration
- Reporting/analytics beyond the basic dashboard
- Multi-currency support

## 8. Out of Scope (for the whole product, not just MVP, unless revisited later)

- Point-of-sale (POS) or e-commerce functionality.
- Accounting, invoicing, or tax computation.
- Customer relationship management.
- Integration with third-party systems (ERP, POS, accounting software).

## 9. Assumptions

These are reasonable defaults chosen to keep the product definition unblocked. They should
be confirmed before or during UI mockup review.

- **A-1**: Single business, single physical location. No multi-warehouse/multi-branch support in MVP.
- **A-2**: Single currency; the product does not need to handle currency conversion. Whether
  the product tracks price/cost at all is an open question (see below).
- **A-3**: Stock quantities are whole units (integers). No fractional or weight-based
  inventory (e.g., kilograms, liters) in MVP.
- **A-4**: Each product has a single unit of measurement; unit conversion is out of scope.
- **A-5** [Updated 2026-08-21, Phase 6]: Users authenticate individually so transactions can
  be attributed to a user (Phase 3), and as of Phase 5 the system enforces the two roles
  named in §3 — Owner can create/edit/deactivate/delete Products, Suppliers, and Categories;
  Staff can perform every inventory operation and every read, the same as Owner —
  **except** that as of Phase 12 a Staff-initiated *adjustment* is a request an Owner
  must approve before it changes stock (an Owner's own adjustment is still immediate).
  As of Phase 6, user management is no longer deferred: an Owner
  can create, edit, deactivate/reactivate, and reset the password of any account through the
  UI (no more direct-database role assignment), and every user can change their own password.
  Still deferred: per-permission granularity beyond the two-role split, and self-service
  signup (accounts are still created *by* an Owner, never by the person who will use them).
  See BR-070–078 and `docs/phase-5-plan.md` / `docs/phase-6-plan.md`.
- **A-6**: No batch, lot, or expiry-date tracking in MVP.
- **A-7**: Product categories are a light organizational aid (Should Have), not required for
  MVP correctness.

## 10. Open Questions

These affect the UI mockup and should be resolved before or during that phase.

- **Q-1 [Resolved 2026-08-19]**: Pure quantity-tracking system for MVP — no price/cost
  fields anywhere, no "stock value" on the dashboard. Revisit only if pricing becomes a
  real near-term need.
- **Q-2 [Resolved 2026-08-19]**: Supplier is optional on stock-in. A stock-in transaction
  may reference a Supplier but does not require one; this keeps Stock-In and Supplier
  loosely coupled per the domain model.
- **Q-3 [Resolved 2026-08-19]**: Low-stock threshold is per-product only, no global
  fallback default. A product with no threshold set is simply never flagged low-stock
  (see BR-061).
- **Q-4**: Should stock-out represent only internal/manual removal, or should it also model
  a "sale" concept (customer, price)? This affects whether a Sale/Order entity is needed.
- **Q-5 [Resolved 2026-08-20, Phase 4]**: Flat list — no hierarchy. `Category` has never
  had a `parentId`, and nothing about building CRUD (Phase 4) changed the argument for
  staying flat: a small business's product list doesn't need subcategories. See
  `docs/phase-4-plan.md` §1.
- **Q-6 [Resolved 2026-09-03, Phase 12]**: Yes, in the narrow form — a **Staff-initiated**
  adjustment is a request that an Owner approves or rejects before it changes stock; an
  **Owner-initiated** adjustment is recorded immediately, exactly as before. Requiring an
  Owner to approve their own adjustment would be theatre (they are the approving
  authority). Not a general approval engine — general approval workflows stay Future (§7).
  See `docs/phase-12-plan.md`, `business-rules.md` BR-072 (amended) and BR-085–089,
  `requirements.md` FR-066.
- **Q-7**: Multi-location support — confirmed out of MVP, but is it a near-term Future item
  the mockup should visually anticipate (e.g., a location field reserved for later), or
  fully ignored for now?
- **Q-8 [Resolved 2026-08-20, Phase 5]**: Two roles, Owner and Staff — the two named in §3
  (business owner/manager, stock/inventory staff). They now behave differently server-side,
  not just informally: Owner-only for Product/Supplier/Category writes, both roles for
  everything else (BR-070–073). See `docs/phase-5-plan.md`.

## 11. Cross-References

- MVP requirements → `requirements.md`
- Business rules governing stock behavior → `business-rules.md`
- Entities referenced above (Product, Supplier, Inventory Transaction, User) →
  `domain-model.md`
- **[Added 2026-08-24, Phase 7]** `created_at`/`updated_at` audit timestamps
  (`docs/phase-7-plan.md`, `domain-model.md` §8) — a data-model consistency change,
  not a product decision. It resolves none of the open questions in §10 (Q-4, Q-6,
  Q-7 remain exactly as open as before) and adds no new scope to §7; it's the
  follow-on named in `docs/phase-6-plan.md` §7's "`created_at`/`updated_at` on
  `users`" line, now done.
- **[Added 2026-08-25, Phase 9]** The audit log (`docs/phase-9-plan.md`,
  `business-rules.md` BR-082–084, `requirements.md` FR-065) — this phase's one
  genuine product-level edit, unlike Phase 7's: §4 gained a user goal and §5 gained a
  use case above. It resolves **none** of §10's open questions — Q-4, Q-6, and Q-7
  remain exactly as open as before — and in particular is **not** a resolution of
  Q-6 despite the surface resemblance: a log records what happened; an approval
  gates what may happen. Different features.
- **[Added 2026-08-25, Phase 10]** The schema-wide `timestamptz` conversion
  (`docs/phase-10-plan.md`, `domain-model.md` §8) — a data-model consistency change,
  same shape as the Phase 7 entry above rather than Phase 9's: §4 gains no user goal
  and §5 gains no use case. It resolves none of §10's open questions — Q-4, Q-6, and
  Q-7 remain exactly as open as before.
- **[Added 2026-08-27, Phase 11]** Bounded reads (`docs/phase-11-plan.md`,
  `api.md`, `requirements.md`'s Phase 11 note) — the two transaction log reads are now
  capped at a `limit`, the way `/audit-events` already was, and a capped response says
  so with an `X-Result-Truncated` header. Same shape as the Phase 7 and Phase 10
  entries, not Phase 9's: §4 gains no user goal, §5 gains no use case, §7 gains no
  scope. It resolves none of §10's open questions — Q-4, Q-6, and Q-7 remain exactly
  as open as before. Bounding the four catalogue reads (`/products`, `/suppliers`,
  `/categories`, `/users`) is explicitly out of scope and deferred with a concrete
  trigger (`docs/phase-11-plan.md` §7).
- **[Added 2026-09-03, Phase 12]** Adjustment approval (`docs/phase-12-plan.md`,
  `business-rules.md` BR-072 amended + BR-085–089, `requirements.md` FR-066,
  `domain-model.md` §3–8, `api.md`). This is a product-level edit in the register of
  Phase 9's, not Phase 7/10/11's: §4 gains no user goal but §5 gains a use case, §7's
  Should Have gains an item and its Future list is narrowed, and §10's **Q-6 is
  resolved**. Q-4 (sale concept) and Q-7 (multi-location) remain open, untouched since
  Phase 5.
