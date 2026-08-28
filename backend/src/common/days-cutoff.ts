// Phase 11 review: the one definition of what `?days=N` means, shared by
// InventoryService and AuditService so "Last 7 days" cannot come to mean two things on
// two screens.
//
// THE CONTRACT: `days=N` covers exactly N calendar dates, ending with today.
// `days=1` is today alone; `days=7` is today plus the previous six dates. A row dated
// six days ago is in, seven days ago is out, and the answer does not change with the
// hour the request is made.
//
// WHAT WENT WRONG BEFORE, precisely. The original cutoff was `new Date()` minus N days
// with the time of day left on it. Because `occurred_at` holds a date with no time,
// that cutoff sat mid-day inside the boundary date and usually excluded it — but not
// always: `occurred_at` stores UTC midnight of the date the user picked in their own
// zone, so whenever the local date runs ahead of the UTC date (the local small hours in
// a positive-offset zone such as this project's UTC+7) the boundary row fell back
// inside the window. Hour-dependent, but only during that daily window — not at every
// hour, and not a plain off-by-one. Snapping to the start of a day removes the
// dependence; subtracting `days - 1` rather than `days` is what makes the window N
// dates instead of N+1.
//
// WHY TWO FUNCTIONS AND NOT ONE. They express the same contract against two different
// kinds of column, and a single formula is provably wrong for one of them:
//
//   swept over all 24 hours, days=7, distinct dates returned
//                            occurred_at (date-only)   created_at (instant)
//     local start-of-day       7 at offset >= 0          7 everywhere
//                              6 at offset <  0
//     UTC-anchored             7 everywhere              8 at offset < 0
//
// A date-only column must be compared against the same construction that wrote it
// (UTC midnight of a local calendar date); an instant column must be compared against a
// real local instant. On this project's UTC+7 the two agree exactly, which is precisely
// why picking either by accident would have looked correct forever.

// For a date-only column — `inventory_transactions.occurred_at`, written as
// `new Date('YYYY-MM-DD')`, i.e. UTC midnight of the local date the user picked.
// Anchored the same way, so the comparison is exact in any zone.
export function daysCutoffForDateColumn(days: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)),
  );
}

// For a real instant column — `audit_events.created_at`, a server timestamp that lands
// at every hour of the day. The boundary a person means is the start of their own
// calendar day, so this is local midnight of `today - (days - 1)`.
export function daysCutoffForInstantColumn(days: number): Date {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}
