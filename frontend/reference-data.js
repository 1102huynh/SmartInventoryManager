// Fork B (docs/phase-13-plan.md §1): the reference-data cache, same accessor
// pattern as session.js. Populated once right after login (see
// Store.loadReferenceData) — categories rarely change and every screen that needs
// them (product list/detail/form, the category admin screen) reads this
// synchronously instead of re-fetching on every render.
//
// FR-005/phase-4-plan.md §3: each category mutation re-populates this from the
// server afterward (Store.createCategory/updateCategory/deleteCategory) rather than
// hand-patching the array, so every synchronous reader stays correct.

let categories = [];

export function getCategories(){ return categories; }
export function setCategories(list){ categories = list; }

// Keyed lookup by numeric id. Returns null when the id isn't known (e.g. a product
// whose category was just deleted).
export function getCategory(id){ return categories.find(c => c.id === id) || null; }
