// The router: the app shell template, hash parsing, the owner-only route gate, and
// the dispatch from a hash to a view. This is the hub — it imports session.js,
// ui.js, api.js, and every view module. The router.js ↔ api.js and router.js ↔
// view-module import cycles are runtime-only (no module calls another at evaluation
// time), which ES modules handle without issue.
//
// Phase 13 (docs/phase-13-plan.md §2): the `Views = {}` registry is gone — in a
// module world the `import` *is* the registry, and the router's dependency on each
// view is now explicit and greppable.

import { ROLE_LABEL } from './config.js';
import { getAccessToken, getCurrentUser, isOwner } from './session.js';
import { UI } from './ui.js';
import { Store } from './api.js';

import { login, account } from './views/auth.js';
import { dashboard } from './views/dashboard.js';
import { productList, productDetail, productForm } from './views/products.js';
import { transactionWizard, historyView } from './views/transactions.js';
import { supplierList, supplierDetail, supplierForm } from './views/suppliers.js';
import { categoryList } from './views/categories.js';
import { userList, userForm } from './views/users.js';
import { auditLog } from './views/audit.js';
import { approvals } from './views/approvals.js';

// Phase 1's shell showed live counts (total products, suppliers, low-stock) directly
// in the sidebar, for free, because everything sat in local arrays already in memory.
// Phase 2 could still do that, but only by firing extra fetches purely to populate a
// sidebar badge on every single navigation — not worth it for what those counts add;
// the Dashboard's stat tiles already own that job properly (one real fetch, on the
// one screen where "totals" is the point). So the shell drops them here.
function shellTemplate(section){
  const navItem = (key, hash, label, icon, badgeId) => `
    <a class="nav-item${section===key?' active':''}" href="${hash}">
      ${UI.icon(icon)}<span class="label">${label}</span>${badgeId ? `<span class="nav-badge" id="${badgeId}" hidden></span>` : ''}
    </a>`;
  // The current user is set by Store.login() — renderApp() never calls into
  // shellTemplate at all until a login has actually succeeded, so it's always set by
  // the time any view renders.
  const user = getCurrentUser() || { initials: '?', name: 'Unknown', role: '' };
  return `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="wordmark">Smart<span>Inventory</span></div>
        <div class="tagline">Manager</div>
      </div>
      <nav class="sidebar-nav">
        ${navItem('dashboard', '#/dashboard', 'Dashboard', 'dashboard')}
        ${navItem('products', '#/products', 'Products', 'products')}
        ${navItem('suppliers', '#/suppliers', 'Suppliers', 'suppliers')}
        ${navItem('history', '#/history', 'Inventory History', 'history')}
        ${navItem('approvals', '#/approvals', 'Approvals', 'history', isOwner() ? 'nav-approvals-badge' : null)}
        ${isOwner() ? navItem('users', '#/users', 'Users', 'users') : ''}
        ${isOwner() ? navItem('audit', '#/audit', 'Audit Log', 'history') : ''}
      </nav>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="topbar-title" id="topbar-title">Smart Inventory Manager</div>
        <div class="user-chip">
          <div class="user-avatar">${UI.esc(user.initials || user.name.slice(0,2).toUpperCase())}</div>
          <div class="user-meta"><div class="name">${UI.esc(user.name)}</div><div class="role">${UI.esc(ROLE_LABEL[user.role] || user.role)}</div></div>
          <a class="btn btn-ghost btn-sm" href="#/account">Account</a>
          <button class="btn btn-ghost btn-sm" id="logout-btn" type="button">Sign out</button>
        </div>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;
}

function parseHash(){
  let hash = location.hash.slice(1) || '/dashboard';
  const [path, queryStr] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, query: new URLSearchParams(queryStr || '') };
}

export function renderApp(){
  const root = document.getElementById('root');

  // Gate the whole app shell on having a token, rather than a route guard on each
  // individual view — one check instead of one per screen, and it can't be
  // forgotten on a route added later (same "register the cross-cutting thing once"
  // reasoning the backend's global JwtAuthGuard follows — see
  // docs/phase-3-plan.md "Guard rollout"). Whatever hash the user landed on is
  // simply ignored until they've signed in.
  if (!getAccessToken()){
    root.innerHTML = '';
    login(root);
    return;
  }
  if (!location.hash || location.hash === '#' || location.hash === '#/login'){
    location.hash = '#/dashboard';
    return;
  }
  const { parts, query } = parseHash();

  // Phase 5 (docs/phase-5-plan.md §3 "One route guard, not one per view"): the same
  // single-gate pattern as the token check above, applied to the small set of
  // owner-only routes, for a Staff user who arrives by typed URL or stale bookmark —
  // the server (RolesGuard) would 403 these anyway; this just avoids showing a form
  // that can only fail. Server-side is still the actual enforcement point.
  // Phase 6 (docs/phase-6-plan.md §3): '#/account' is deliberately NOT included here —
  // it's the one non-dashboard route both roles share equally (self-service password
  // change), reachable from the user chip regardless of role.
  const isOwnerOnlyRoute =
    (parts[0] === 'products' && (parts[1] === 'new' || parts[2] === 'edit')) ||
    (parts[0] === 'suppliers' && (parts[1] === 'new' || parts[2] === 'edit')) ||
    parts[0] === 'categories' ||
    parts[0] === 'users' ||
    parts[0] === 'audit';
  if (isOwnerOnlyRoute && !isOwner()){
    UI.toast("You don't have permission to view that page.", 'error');
    location.hash = '#/dashboard';
    return;
  }

  const section = parts[0] || 'dashboard';
  root.innerHTML = shellTemplate(section);
  document.getElementById('logout-btn').addEventListener('click', () => Store.logout());
  // Phase 12 (docs/phase-12-plan.md §3 item 4): the pending-approvals count on the
  // Approvals nav item, for Owners. Chrome, not dashboard data — a nav badge, so it
  // costs one bounded read here and needs no change to /dashboard/summary (BR-062).
  if (isOwner()) updateApprovalsBadge();
  const view = document.getElementById('view');
  const crumb = document.getElementById('topbar-title');

  try {
    if (parts[0] === 'dashboard' || parts.length === 0){
      crumb.textContent = 'Dashboard';
      dashboard(view, query);
    } else if (parts[0] === 'products' && parts.length === 1){
      crumb.textContent = 'Products';
      productList(view, query);
    } else if (parts[0] === 'products' && parts[1] === 'new'){
      crumb.textContent = 'New Product';
      productForm(view, null);
    } else if (parts[0] === 'products' && parts.length === 2){
      crumb.textContent = 'Product Detail';
      productDetail(view, parts[1]);
    } else if (parts[0] === 'products' && parts[2] === 'edit'){
      crumb.textContent = 'Edit Product';
      productForm(view, parts[1]);
    } else if (parts[0] === 'products' && parts[2] === 'stock-in'){
      crumb.textContent = 'Stock In';
      transactionWizard(view, parts[1], 'stock-in');
    } else if (parts[0] === 'products' && parts[2] === 'stock-out'){
      crumb.textContent = 'Stock Out';
      transactionWizard(view, parts[1], 'stock-out');
    } else if (parts[0] === 'products' && parts[2] === 'adjust'){
      crumb.textContent = 'Adjust Stock';
      transactionWizard(view, parts[1], 'adjustment');
    } else if (parts[0] === 'history'){
      crumb.textContent = 'Inventory History';
      historyView(view, query);
    } else if (parts[0] === 'suppliers' && parts.length === 1){
      crumb.textContent = 'Suppliers';
      supplierList(view, query);
    } else if (parts[0] === 'suppliers' && parts[1] === 'new'){
      crumb.textContent = 'New Supplier';
      supplierForm(view, null);
    } else if (parts[0] === 'suppliers' && parts.length === 2){
      crumb.textContent = 'Supplier Detail';
      supplierDetail(view, parts[1]);
    } else if (parts[0] === 'suppliers' && parts[2] === 'edit'){
      crumb.textContent = 'Edit Supplier';
      supplierForm(view, parts[1]);
    } else if (parts[0] === 'categories' && parts.length === 1){
      crumb.textContent = 'Categories';
      categoryList(view, query);
    } else if (parts[0] === 'users' && parts.length === 1){
      crumb.textContent = 'Users';
      userList(view, query);
    } else if (parts[0] === 'users' && parts[1] === 'new'){
      crumb.textContent = 'New User';
      userForm(view, null);
    } else if (parts[0] === 'users' && parts[2] === 'edit'){
      crumb.textContent = 'Edit User';
      userForm(view, parts[1]);
    } else if (parts[0] === 'audit'){
      crumb.textContent = 'Audit Log';
      auditLog(view, query);
    } else if (parts[0] === 'approvals'){
      crumb.textContent = 'Approvals';
      approvals(view, query);
    } else if (parts[0] === 'account'){
      crumb.textContent = 'My Account';
      account(view);
    } else {
      view.innerHTML = UI.emptyState('Page not found', 'That screen does not exist in this mockup.');
    }
  } catch (err) {
    view.innerHTML = UI.errorState(err.message || 'Unexpected error rendering this screen.', 'retry-render');
  }
  window.scrollTo(0, 0);
}

// Phase 12: fetch the pending count and show it on the Approvals nav item. Best-effort
// and silent on failure — a missing badge must never break navigation. Called on every
// render (so it stays fresh as requests are resolved) and again by Views.approvals
// after an approve/reject/withdraw.
export function updateApprovalsBadge(){
  const badge = document.getElementById('nav-approvals-badge');
  if (!badge) return;
  Store.countPendingAdjustments()
    .then(({ count, more }) => {
      const el = document.getElementById('nav-approvals-badge');
      if (!el) return;
      if (count > 0){
        el.textContent = more ? `${count}+` : String(count);
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    })
    .catch(() => {});
}
