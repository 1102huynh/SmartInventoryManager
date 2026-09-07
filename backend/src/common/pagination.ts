// Phase 14 (docs/phase-14-plan.md §1). Optional offset paging for the four catalogue
// list reads (`/products`, `/suppliers`, `/categories`, `/users`).
//
// The asymmetry with Phase 11's log reads is deliberate and documented in `api.md`: a
// log read returns "the most recent N + filters + `X-Result-Truncated`" — a reading
// position — while a catalogue read returns "page N of a total". Offset pagination is
// the wrong tool for a table where rows arrive at the top (Phase 11 §7 refused it for
// the logs) and the right one for a name-ordered catalogue a person grows a few times
// a week: the skipped-row window needs someone to insert a row above the current page
// mid-click, and it buys the two things a catalogue UI wants and keyset cannot give
// cheaply — a real `total` ("Page 3 of 12 · 573 products") and random access.
//
// Paging is OPTIONAL on every one of the four routes: `resolvePaging` returns `null`
// when neither `page` nor `pageSize` is present, and the service then returns the bare
// array exactly as before — the shape the stock/adjustment wizard pickers and the
// `CATEGORIES` reference cache still depend on (§1). Only the list screens pass the
// params.

// Fork E (docs/phase-14-plan.md §1): module constants, not a `configuration.ts` entry
// — "no deployment tunes a page size", the same call Phase 11 made for the log
// `limit`. The client may ask for a smaller page via `?pageSize=`; the ceiling is
// validation in the DTO (`@Max(MAX_PAGE_SIZE)`), so `pageSize=1000` is a documented
// `400`, never a silent clamp.
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

// The paged response shape, returned only when a paging param was supplied. `total` is
// the count of the *filtered* set, not the whole table — so "Page 3 of 12" counts the
// same rows the page is drawn from.
export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// A resolved paging window: `page`/`pageSize` echoed back into the envelope, plus the
// `skip`/`take` a repository (or a query builder's `.offset()`/`.limit()`) consumes.
export interface PageRequest {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

// Absent means "the whole list". Supplied — *either* param — means a paged envelope,
// with the other param defaulted (`page` → 1, `pageSize` → DEFAULT_PAGE_SIZE). A
// `page` past the last is not an error here: it yields `skip` beyond the row count, an
// empty `items`, and the real `total` (the frontend disables Next before this happens;
// a hand-typed URL gets an empty table, not a 404).
export function resolvePaging(query: {
  page?: number;
  pageSize?: number;
}): PageRequest | null {
  if (query.page === undefined && query.pageSize === undefined) return null;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function pageEnvelope<T>(
  items: T[],
  total: number,
  req: PageRequest,
): Paged<T> {
  return { items, page: req.page, pageSize: req.pageSize, total };
}
