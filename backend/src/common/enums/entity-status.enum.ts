// Shared by Product and Supplier (BR-002 / FR-013) — both have the same Active/Inactive
// lifecycle, so one enum instead of two identical ones.
export enum EntityStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}
