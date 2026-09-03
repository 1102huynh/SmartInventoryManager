// Phase 12 (docs/phase-12-plan.md §1 "Four statuses, because withdrawal is a
// different fact from rejection"): the lifecycle of a Staff-initiated adjustment
// request. `pending` on insert; exactly one of the other three is terminal — there is
// no un-reject, no re-open, no edit (BR-087). A superseded count is a *new* request,
// in the same spirit as BR-051's "corrections are a new transaction, never an edit."
//
// `withdrawn` is deliberately not folded into `rejected`: "I changed my mind about my
// own count" and "the Owner did not accept this count" are different facts, and a
// screen that shows them as the same one cannot answer the question it is opened to
// ask — the same reasoning BR-082 gives for keeping actor and subject as two columns.
//
// Snake_case values, matching TransactionType, UserRole, and AuditEventType.
export enum AdjustmentRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  WITHDRAWN = 'withdrawn',
}
