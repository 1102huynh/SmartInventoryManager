// product.md §3 names exactly two target users — business owner/manager and stock/
// inventory staff — and phase-5-plan.md §1 deliberately stops there: no third role,
// no permission table. Owner is the master-data role (products/suppliers/categories
// create/edit/delete); Staff can do everything else an authenticated user can do,
// including stock-in/out/adjustment (see RolesGuard, roles.decorator.ts).
export enum UserRole {
  Owner = 'owner',
  Staff = 'staff',
}
