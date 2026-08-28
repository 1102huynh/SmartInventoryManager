import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { RESULT_TRUNCATED_HEADER } from './result-truncated.header';

// The frontend is a separate origin — a plain static server on :5173 talking to this
// API on :3000 (frontend/serve.js says so in its own header comment) — so every
// response it reads is a cross-origin response.
//
// `exposedHeaders` is the part that is easy to miss and impossible to notice missing.
// A browser lets page JavaScript read only the CORS-safelisted response headers
// (Cache-Control, Content-Language, Content-Length, Content-Type, Expires,
// Last-Modified, Pragma) unless the server names the others in
// `Access-Control-Expose-Headers`. Without this list, `app.enableCors()` still sets
// every other CORS header correctly, the API still SENDS X-Result-Truncated, curl
// still shows it — and `res.headers.get('X-Result-Truncated')` in the browser returns
// null, every time. The Phase 11 "Showing the most recent 100 movements" notice would
// then never render, and the history screens would go back to stopping silently in the
// middle of the record: exactly the defect docs/phase-11-plan.md §1 exists to remove,
// reintroduced one layer further out.
//
// Nothing in the backend test suite can catch that on its own — supertest speaks to the
// HTTP server in-process, where no browser and therefore no CORS enforcement exists. So
// the options live here, as one object shared by main.ts and app.e2e-spec.ts, and the
// e2e test asserts the one half a server-side test honestly can: that a real response
// carries Access-Control-Expose-Headers naming these headers. Browser enforcement of
// that header is the spec's half, and is verified by opening the app (README).
//
// `Retry-After` is the second entry, for the same reason as the first: @nestjs/throttler
// SENDS it on every 429 (api.md's Phase 8 section documents it as part of the 429
// contract), curl shows it, and page JavaScript could not read it without it being
// named here. It is not CORS-safelisted. The frontend does not consume it today, but
// the header is part of the documented contract and a cross-origin caller that wants
// to honour the back-off must be able to see it.
export const CORS_OPTIONS: CorsOptions = {
  exposedHeaders: [RESULT_TRUNCATED_HEADER, 'Retry-After'],
};
