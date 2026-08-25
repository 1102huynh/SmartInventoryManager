// Phase 9 (docs/phase-9-plan.md §1 "What is recorded — a closed list"): every event
// type this application ever writes to audit_events. Deliberately closed — there is
// no code path that records an AuditEventType not listed here, and that closure is
// what keeps this table small enough to read without pagination (see AuditService and
// the exclusions §1 spends most of its length on: no reads, no stock movements — those
// stay in inventory_transactions, BR-083 — and no 429 throttle rejections).
//
// Snake_case values, matching the wire format TransactionType and UserRole already use.
export enum AuditEventType {
  LOGIN_SUCCEEDED = 'login_succeeded',
  LOGIN_FAILED = 'login_failed',
  ACCOUNT_LOCKED = 'account_locked',
  PASSWORD_CHANGED = 'password_changed',
  USER_CREATED = 'user_created',
  USER_UPDATED = 'user_updated',
  USER_STATUS_CHANGED = 'user_status_changed',
  USER_PASSWORD_RESET = 'user_password_reset',
  PRODUCT_CREATED = 'product_created',
  PRODUCT_UPDATED = 'product_updated',
  PRODUCT_STATUS_CHANGED = 'product_status_changed',
  PRODUCT_DELETED = 'product_deleted',
  SUPPLIER_CREATED = 'supplier_created',
  SUPPLIER_UPDATED = 'supplier_updated',
  SUPPLIER_STATUS_CHANGED = 'supplier_status_changed',
  CATEGORY_CREATED = 'category_created',
  CATEGORY_UPDATED = 'category_updated',
  CATEGORY_DELETED = 'category_deleted',
}
