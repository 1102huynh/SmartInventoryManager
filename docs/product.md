# Product Definition — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-20

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

**Future (explicitly postponed):**
- Multi-location / multi-warehouse inventory
- Purchase order workflow (request → approve → receive)
- Barcode / QR scanning
- Batch, lot, and expiry-date tracking
- Multi-unit conversion (e.g., box ↔ piece)
- Role-based access control beyond basic user attribution
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
- **A-5**: Users authenticate individually so transactions can be attributed to a user, but
  fine-grained role-based permissions are deferred; MVP assumes all authenticated users can
  perform inventory operations.
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
- **Q-6**: Should adjustments require any approval step (e.g., manager confirmation), or is
  a recorded reason sufficient for MVP?
- **Q-7**: Multi-location support — confirmed out of MVP, but is it a near-term Future item
  the mockup should visually anticipate (e.g., a location field reserved for later), or
  fully ignored for now?
- **Q-8**: What user roles exist, even informally (e.g., Owner vs. Staff), and do they need
  to behave differently anywhere in the UI for Phase 0/1 purposes?

## 11. Cross-References

- MVP requirements → `requirements.md`
- Business rules governing stock behavior → `business-rules.md`
- Entities referenced above (Product, Supplier, Inventory Transaction, User) →
  `domain-model.md`
