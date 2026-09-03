# UI Open Questions — Phase 1 (UI Mockup)

Status: Phase 1 — UI Mockup
Last updated: 2026-08-19

These questions surfaced while building the navigable UI mockup at
`docs/product.md` / `requirements.md` / `business-rules.md` / `domain-model.md` strictly.
Each one is a place where the mockup had to make a concrete choice that the source
documents don't fully settle. The documents themselves were **not** modified for any
of these — see them resolved (or left open) here, then fold the outcome back into
`business-rules.md` / `requirements.md` in the next phase.

---

## Q-UI-1: Is Adjustment allowed on an Inactive product?

- **Related rule**: BR-013 / domain-model.md §6 invariant — "A Stock-In or Stock-Out
  transaction cannot be created against an Inactive Product." Adjustment is not
  mentioned either way.
- **Why it matters**: A product is typically deactivated *because* it's discontinued
  or being wound down — which is exactly when a final stocktake correction is most
  likely to be needed. If Adjustment is blocked like Stock-In/Stock-Out, there's no
  way to zero out or correct a discontinued product's stock once it's inactive.
- **What the mockup does**: Stock In / Stock Out are disabled on an inactive product
  (with an inline explanation); Adjustment stays enabled.
- **Options**: (a) confirm the mockup's behavior and add it to business-rules.md as
  an explicit rule, or (b) block Adjustment too, and require reactivation first.
- **[Noted 2026-09-03, Phase 12]** Still holds, and it holds for a Staff-initiated
  *adjustment request* too: `AdjustmentsService.submit` does not check product status,
  and `applyApprovedAdjustment` locks the product row without a status check — a
  discontinued product can still have a pending request submitted and approved.

## Q-UI-2: How is an Adjustment quantity actually entered?

- **Related rule**: BR-030/BR-031 describe adjustments as increasing or decreasing
  stock by a delta, but never say whether the user types that delta directly or
  types the new counted total.
- **Why it matters**: This is a real UX and correctness decision. Typing a raw delta
  (e.g. "-3") asks staff to do subtraction in their head during a stocktake and makes
  sign errors easy. Typing the new counted quantity matches how a physical count
  actually happens, and — as a side effect — makes it structurally impossible to
  violate BR-033/BR-041 (stock can't go negative) since the input has a `min="0"`.
- **What the mockup does**: "New Counted Quantity" (absolute), with the delta shown
  automatically in the review step.
- **Options**: (a) confirm "new counted quantity" as the standard, or (b) also offer a
  raw "+/-" delta mode for cases where staff already know the adjustment amount and
  don't want to re-count everything.
- **[Noted 2026-09-03, Phase 12]** The "new counted quantity" choice turned out to be
  load-bearing for adjustment approval: because a Staff-initiated adjustment can now
  sit as a pending request for hours or days, a stored *delta* would go stale if stock
  moved in the meantime, while "the count was 40" stays exactly what was observed.
  `adjustment_requests` stores `new_quantity`, and the delta is computed at approval
  under lock (BR-086). A raw "+/-" delta mode (option b) would need a different answer
  for the request path — recorded here so a later refactor toward it does not quietly
  reintroduce the staleness.

## Q-UI-3: What are the actual Adjustment reason categories?

- **Related rule**: BR-032 — "reason may be free text or a selected reason category;
  a reason is mandatory in either case." No taxonomy is defined anywhere.
- **Why it matters**: The category list shapes reporting later (e.g. "how much
  shrinkage from theft vs. damage this quarter") — it's a real business decision, not
  just a UI detail.
- **What the mockup uses**: *Stocktake discrepancy, Damaged, Lost/theft, Data-entry
  correction, Other* (free text required when "Other" is picked).
- **Options**: confirm this list, or supply the business's actual preferred set.

## Q-UI-4: FR-060 (login) has no screen in this mockup

- **Related requirement**: FR-060 — "A user must authenticate to use the system,"
  marked **Must** for MVP.
- **Why it matters**: Every other MVP Must-have requirement is represented in this
  mockup; login is the one exception. Per this phase's brief ("Potential screens"
  list did not include Login, and the mockup's job is to validate inventory
  workflows), a login screen was treated as out of scope for Phase 1 and the mockup
  instead simulates an already-authenticated session (a static "Signed in as Jordan
  Lee · Staff" chip in the top bar) to keep FR-061 attribution visible.
- **Options**: (a) confirm login can stay out of the Phase 1 mockup and gets designed
  in a later pass, or (b) add a minimal login screen now for completeness.
- **Resolved (Phase 3)**: option (a) — a real login screen (`Views.login`,
  `frontend/index.html`) replaced the static chip once real authentication existed to
  back it. See `docs/phase-3-plan.md` §3 "Frontend changes".

## Q-UI-5: Should a deactivated Supplier's past transactions still show it?

- **Related rule**: Not stated anywhere — inferred from BR-051 (immutability).
- **Why it matters**: FR-013 says an inactive supplier can't be *selected* for new
  stock-in, but says nothing about suppliers already referenced by historical
  transactions. If BR-051 (history is immutable) holds, a supplier's past stock-in
  records must keep showing it even after it's deactivated.
- **What the mockup does**: The mock data includes a supplier (Sunrise Wholesale)
  that is now Inactive but still appears correctly on two products' transaction
  history and on its own Supplier Detail page.
- **Options**: confirm this is correct and add it to business-rules.md explicitly
  (it currently has to be inferred from BR-051 rather than stated).

## Q-UI-6: Low-stock has no dedicated screen — is a filtered view sufficient?

- **Related requirement**: FR-042 — "User can view the list of all products
  currently flagged as low-stock."
- **Why it matters**: The "Potential screens" list in this phase's brief separately
  named a low-stock view, but domain-model.md treats low-stock purely as a Product
  attribute, not its own entity — a dedicated screen would just be the Product List
  pre-filtered.
- **What the mockup does**: No separate screen. The Product List has an "All /
  Active / Inactive / Low Stock / Out of Stock" filter, and the Dashboard's "Low
  Stock" and "Out of Stock" stat tiles link straight into that filtered view. This
  keeps one product table instead of two near-duplicate ones.
- **Options**: confirm the filtered-view approach satisfies FR-042, or specify what a
  standalone low-stock screen should show that the filtered list doesn't.

## Q-UI-7: Stock-Out reason vs. Q-4 (sale modeling) — still open

- **Related open question**: product.md Q-4, unresolved — "Should stock-out
  represent only internal/manual removal, or should it also model a 'sale' concept
  (customer, price)?"
- **Why it matters**: This directly shapes the Stock-Out screen. The mockup commits
  to the "generic removal" reading (single optional free-text reason field, no
  customer/price), since Q-1 already ruled out pricing for MVP. If Q-4 later
  resolves toward modeling sales, Stock-Out gets a materially different form.
- **What the mockup does**: Stock-Out has Quantity, Date, and an optional free-text
  Reason only.
- **Options**: confirm generic removal is right for MVP (recommended, consistent with
  the Q-1 pricing decision), or resolve Q-4 toward a Sale concept now before Phase 2.

---

## Not Represented / Deferred (for the Scope Validation summary)

- **FR-060 (Login screen)** — see Q-UI-4. Resolved in Phase 3.
- **Category hierarchy (Q-5)** — still open in product.md; mockup uses a flat list,
  consistent with the "reasonable default" framing there.
- **Q-6 (adjustment approval workflow)** — still open; mockup has no approval step,
  consistent with BR-032 requiring only a recorded reason.
- **Q-7 (multi-location)**, **Q-8 (role-based UI differences)** — out of scope per
  product.md; nothing in the mockup anticipates either.
