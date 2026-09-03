// Pure constants and pure functions — the leaves of the module graph. This module
// imports nothing; everything else imports it.
//
// Phase 2: this file used to hold the mockup's hand-authored mock arrays (products,
// suppliers, transactions...). All of that now lives in PostgreSQL, behind the
// NestJS API — see api.js, whose Store replaces every one of those arrays with a
// fetch() call. What's left here is the date-default helper (still needed for form
// fields), the display-label maps, and the normalize-at-the-boundary functions that
// turn each wire shape into what the views render.

export const API_BASE = window.API_BASE || 'http://localhost:3000';

export function todayInputValue(){
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// The stored role ('owner'/'staff', Phase 5) stops being the display value once it's
// a lowercase enum on the wire — this is the one place that gets translated back for
// display (the shell's user chip, the Users list).
export const ROLE_LABEL = { owner: 'Owner', staff: 'Staff' };

// The backend's transaction `type` values are 'stock_in'/'stock_out'/'adjustment'
// (see common/enums/transaction-type.enum.ts); the UI's routes and internal code use
// the hyphenated 'stock-in'/'stock-out'/'adjustment' instead (see the router).
// normalizeTx() is the one place that translation happens, so the rest of the view
// code never has to think about it.
export function normalizeTx(t){
  return {
    id: t.id,
    productId: t.productId,
    type: t.type === 'stock_in' ? 'stock-in' : t.type === 'stock_out' ? 'stock-out' : 'adjustment',
    delta: t.quantityDelta,
    date: new Date(t.occurredAt),
    reason: t.reason || '',
    supplier: t.supplier || null,
    recordedBy: t.recordedBy || null,
    product: t.product || null,
  };
}

// Phase 9 (docs/phase-9-plan.md §3): the wire shape (snake_case-derived eventType,
// nested actor/subject User objects, ISO createdAt) turned into what the Audit Log
// view actually renders — the same normalize-at-the-boundary pattern normalizeTx uses.
export function normalizeAuditEvent(e){
  return {
    id: e.id,
    eventType: e.eventType,
    date: new Date(e.createdAt),
    actor: e.actor || null,
    subject: e.subject || null,
    entityType: e.entityType || null,
    entityId: e.entityId ?? null,
    summary: e.summary,
    actorIp: e.actorIp || null,
  };
}

// Phase 12 (docs/phase-12-plan.md §3): an adjustment request as the Approvals screen
// renders it. `delta` is the server's approval-time recomputation of newQuantity minus
// current stock — recomputed on every list load, never a value frozen at request time
// — so the row can show "you counted 40; it now says 32; that is +8" (§1).
export function normalizeAdjustmentRequest(r){
  const stockNow = typeof r.currentStock === 'number' ? r.currentStock : null;
  return {
    id: r.id,
    productId: r.productId,
    product: r.product || null,
    newQuantity: r.newQuantity,
    stockAtRequest: r.stockAtRequest,
    currentStock: stockNow,
    delta: stockNow === null ? null : r.newQuantity - stockNow,
    occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
    reason: r.reason || '',
    status: r.status,
    requestedBy: r.requestedBy || null,
    resolvedBy: r.resolvedBy || null,
    resolutionReason: r.resolutionReason || '',
    resultingTransactionId: r.resultingTransactionId ?? null,
    createdAt: new Date(r.createdAt),
  };
}
