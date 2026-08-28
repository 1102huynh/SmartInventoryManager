// Phase 11 (docs/phase-11-plan.md §1 "Truncation has to be observable"). A capped
// list response says so with this header — present, with the value 'true', ONLY when
// more rows matched than were returned; absent otherwise. Its presence is the signal,
// not its value: a header that is always there with a boolean string is a different
// contract (see api.md).
//
// The signal costs no extra query. Both services ask the database for `limit + 1`
// rows and return `limit`; if the extra row came back, the header goes on. No
// COUNT(*), no second query.
//
// Set directly in the two inventory controllers and in AuditController rather than by
// an interceptor: an interceptor would have to infer truncation from a response body
// that no longer carries it (docs/phase-11-plan.md §2, and the same instinct Phase 9
// talked itself out of for AuditService.record —
// docs/learning-notes/cross-cutting-concerns.md).
export const RESULT_TRUNCATED_HEADER = 'X-Result-Truncated';

// A bounded read's result, before the controller splits it into a body and a header.
export interface BoundedResult<T> {
  rows: T[];
  truncated: boolean;
}

// The one canonical `limit + 1` probe. InventoryService and AuditService both ask the
// database for one row more than they intend to return; this turns that extra row into
// the two facts a caller needs and drops it. It lives here rather than privately in
// either service because it is the same rule in both, and the phase's own DTO comment
// argues that "leaving two spellings of one rule in the codebase is worse than the one
// line it costs" (query-transactions.dto.ts).
//
// `rows.length > limit` — not `>=` — is the whole boundary: asking for `limit + 1` and
// getting exactly `limit` back means the extra row was requested and genuinely does not
// exist, so the caller has the complete set and `truncated` is false.
export function trimToLimit<T>(rows: T[], limit: number): BoundedResult<T> {
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
}
