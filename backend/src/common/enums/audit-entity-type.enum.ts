// Phase 9 (docs/phase-9-plan.md §1 "The target of an administrative event is
// entity_type + entity_id"): what kind of thing an administrative AuditEvent is
// about, when it's about something beyond the subject user. NULL entityType/entityId
// on every authentication event and on a self-service password change — see
// AuditEvent.entityId's own comment for why that column carries no foreign key.
export enum AuditEntityType {
  USER = 'user',
  PRODUCT = 'product',
  SUPPLIER = 'supplier',
  CATEGORY = 'category',
}
