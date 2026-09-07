// Phase 14 (docs/phase-14-plan.md §3 Fork F / §5 Fork G). The pure paging arithmetic,
// in its own tiny module so it is unit-testable with no DOM at all — `UI.pager`
// (ui.js) imports `pagerModel` for the markup, and `frontend/test/pager.test.js`
// covers it directly. This is the off-by-one-prone part the frontend's first
// automated test exists to pin (`Math.ceil(total / pageSize)`, the last-page
// boundary, the empty and exactly-divisible cases).

// Given the raw paging state, returns everything a pager needs to render and every
// list view needs to decide what to request:
//   page       the current page, clamped into 1..totalPages (a hand-typed ?page=99
//              on a 3-page list resolves to 3, not an error)
//   totalPages at least 1, even when total is 0 — "Page 1 of 1", not "Page 1 of 0"
//   hasPrev/hasNext   drive the disabled state of the two buttons
//   skip       (page - 1) * pageSize — what the server's ?page= maps to, kept here
//              so the view never re-derives it
//   showPager  false when the whole result fits on one page — the control hides
//              entirely (Fork F: "hidden when total <= pageSize")
//   label      "Page X of Y"
export function pagerModel(page, pageSize, total) {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const count = Math.max(0, Math.floor(total) || 0);
  const totalPages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  return {
    page: current,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
    skip: (current - 1) * size,
    showPager: count > size,
    label: `Page ${current} of ${totalPages}`,
  };
}
