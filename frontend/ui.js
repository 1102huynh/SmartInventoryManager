// The UI helper set: escaping, date/quantity formatting, the icon sprite, status
// and type badges, the category chip, toasts, and the empty/error/skeleton/
// truncation render helpers. Imports config.js (nothing yet) and reference-data.js
// (catChip reads categories).

import { getCategory } from './reference-data.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export const UI = {
  esc(str){
    return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  },
  fmtDate(d){
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  },
  fmtDateTime(d){
    let h = d.getHours(), m = String(d.getMinutes()).padStart(2,'0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${this.fmtDate(d)} · ${h}:${m} ${ampm}`;
  },
  fmtQty(n, unit){
    const sign = n > 0 ? '+' : (n < 0 ? '−' : '');
    return `${sign}${Math.abs(n)} ${unit}`;
  },
  // Phase 7 (docs/phase-7-plan.md §3): one shared render helper for the "Added
  // <date>" / "Last updated <date>" lines, rather than three copies in
  // productDetail/supplierDetail/userForm. Returns `<div><span class="k">…</span>…</div>`
  // rows meant to sit inside an existing `.detail-meta` block; returns '' if the
  // entity has no createdAt yet (e.g. a not-yet-loaded skeleton state never calls
  // this, but a defensive check costs nothing). "Last updated" is omitted when it
  // isn't meaningfully different from "Added" — a row's create-time save() can set
  // both within the same insert, and showing "Last updated" for a change that never
  // happened would be exactly the confusion this convention exists to prevent.
  auditMetaHtml(entity){
    if (!entity || !entity.createdAt) return '';
    const created = new Date(entity.createdAt);
    const updated = entity.updatedAt ? new Date(entity.updatedAt) : null;
    let html = `<div><span class="k">Added</span>${this.fmtDate(created)}</div>`;
    if (updated && Math.abs(updated.getTime() - created.getTime()) > 1000) {
      html += `<div><span class="k">Last updated</span>${this.fmtDate(updated)}</div>`;
    }
    return html;
  },
  navigate(hash){ location.hash = hash; },

  icon(name){
    const icons = {
      dashboard:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1"/><rect x="11" y="2.5" width="6.5" height="6.5" rx="1"/><rect x="2.5" y="11" width="6.5" height="6.5" rx="1"/><rect x="11" y="11" width="6.5" height="6.5" rx="1"/></svg>',
      products:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="6" width="15" height="11.5" rx="1"/><path d="M2.5 6 10 2.5 17.5 6"/><path d="M10 6v11.5"/></svg>',
      suppliers:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="8" width="10" height="8" rx="1"/><path d="M12 11h3.5l2.5 2.5V16h-6"/><circle cx="5.5" cy="16.5" r="1.4"/><circle cx="14.5" cy="16.5" r="1.4"/></svg>',
      history:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="3" cy="5" r="1"/><path d="M6 5h11.5"/><circle cx="3" cy="10" r="1"/><path d="M6 10h11.5"/><circle cx="3" cy="15" r="1"/><path d="M6 15h8"/></svg>',
      search:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M17 17l-4-4"/></svg>',
      plus:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3.5v13M3.5 10h13"/></svg>',
      check:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 10.5l4 4 8-9"/></svg>',
      warning:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 2.5 18 17H2z" stroke-linejoin="round"/><path d="M10 8v4"/><circle cx="10" cy="14.3" r=".2" stroke-width="2.4"/></svg>',
      error:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.5"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/></svg>',
      empty:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="14" height="9" rx="1"/><path d="M3 7l2.5-4h9L17 7"/><path d="M8 11h4"/></svg>',
      arrowLeft:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12.5 4.5 6 10l6.5 5.5"/></svg>',
      users:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="6.5" r="2.7"/><path d="M2 17c0-3 2.2-5 5-5s5 2 5 5"/><circle cx="14.5" cy="7.5" r="2.1"/><path d="M12.5 12.3c2.3.3 3.8 2 3.8 4.7"/></svg>',
    };
    return icons[name] || '';
  },

  badgeStatus(status){
    return status === 'active'
      ? '<span class="badge badge-active">Active</span>'
      : '<span class="badge badge-inactive">Inactive</span>';
  },
  // Phase 8 (docs/phase-8-plan.md §3): a locked account is a DIFFERENT state from
  // Inactive (an Owner deactivated it) — this shows up next to the status badge, not
  // instead of it, so the two never get confused when an Owner is looking at "why
  // can't this person log in." Only meaningful when `locked` is actually present on
  // the user object (the Owner-only GET /users shape) — every other caller of this
  // just sees no badge, no error.
  badgeLocked(locked){
    return locked ? '<span class="badge badge-out">Locked</span>' : '';
  },
  // Out-of-stock is the more severe subset of low-stock — showing only one badge keeps
  // the signal legible instead of stacking two chips that mean almost the same thing.
  // Phase 2: reads the fields ProductsService already computed server-side
  // (currentStock/lowStock/outOfStock) instead of recomputing them here.
  badgeStockLevel(product){
    if (product.outOfStock) return '<span class="badge badge-out">Out of stock</span>';
    if (product.lowStock) return '<span class="badge badge-low">Low stock</span>';
    return '';
  },
  typeBadge(type){
    if (type === 'stock-in') return '<span class="badge badge-type-in">Stock In</span>';
    if (type === 'stock-out') return '<span class="badge badge-type-out">Stock Out</span>';
    return '<span class="badge badge-type-adj">Adjustment</span>';
  },
  // Keyed by category NAME rather than a fixed id — Phase 1 used hand-picked ids
  // like 'cat-bev'; the database assigns its own numeric ids on seed, so the name is
  // the only stable thing left to color by.
  catChip(categoryId){
    const cat = getCategory(categoryId);
    if (!cat) return '<span class="cell-sub">—</span>';
    const dotByName = {
      'Beverages & Café Supplies': 'var(--cat-bev)',
      'Cleaning & Janitorial': 'var(--cat-clean)',
      'Office & Stationery': 'var(--cat-office)',
      'Packaging & Shipping': 'var(--cat-pack)',
      'Break Room & Pantry': 'var(--cat-pantry)',
    };
    const dot = dotByName[cat.name] || 'var(--ink-faint)';
    return `<span class="cat-chip" style="--dot:${dot}">${UI.esc(cat.name)}</span>`;
  },

  toast(message, type){
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.innerHTML = (type === 'success' ? UI.icon('check') : type === 'error' ? UI.icon('error') : '') + `<span>${UI.esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, 3400);
  },

  // Phase 1 wrapped a synchronous mock-data read in an artificial delay to fake
  // network latency. Phase 2's `factory` already talks to a real API over real
  // network, so the delay is gone — but the "Preview state" control (below) still
  // needs a way to force an error without actually calling the API, which is what
  // forceState:'error' does. Promise.resolve().then(factory) (rather than just
  // `return factory()`) guarantees this always returns a genuine Promise even if a
  // view's factory synchronously returns a plain value for its own 'empty' case.
  mockFetch(factory, { forceState = null } = {}){
    if (forceState === 'error'){
      return Promise.reject(new Error('Could not reach the server. Check your connection and try again.'));
    }
    return Promise.resolve().then(factory);
  },

  // A dev-only affordance (not part of the real product) so a reviewer can preview
  // Loading / Empty / Error states without needing a real backend to misbehave.
  previewControl(current){
    const opts = [['normal','Normal'],['loading','Loading'],['empty','Empty (no data)'],['error','Error']];
    return `<div class="preview-state" title="Review-only control to preview UI states">
      <label for="preview-select">Preview state</label>
      <select id="preview-select">${opts.map(([v,l]) => `<option value="${v}" ${v===current?'selected':''}>${l}</option>`).join('')}</select>
    </div>`;
  },

  skeletonRows(cols, rows){
    let out = '';
    for (let r = 0; r < rows; r++){
      out += '<tr class="skeleton-row">' + Array.from({length: cols}).map(() => `<td><div class="skeleton skeleton-line" style="width:${60 + Math.round(Math.random()*30)}%"></div></td>`).join('') + '</tr>';
    }
    return out;
  },
  emptyState(title, body){
    return `<div class="empty-state">${UI.icon('empty')}<h3>${UI.esc(title)}</h3><p>${UI.esc(body)}</p></div>`;
  },
  errorState(message, retryId){
    return `<div class="error-state">${UI.icon('error')}<h3>Something went wrong</h3><p>${UI.esc(message)}</p><button class="btn btn-secondary btn-sm" id="${retryId}">Retry</button></div>`;
  },
  // Phase 11 (docs/phase-11-plan.md §1 "Truncation has to be observable"): the one
  // notice every bounded list renders when the server's X-Result-Truncated header came
  // back. Four screens show it now — Inventory History, Product Detail's history
  // panel, Supplier Detail's "received from" panel, and the Audit Log — and the point
  // of one helper is that a fifth bounded list cannot accidentally word it differently
  // or, worse, forget it. `noun` and `hint` vary per screen: Inventory History and the
  // Audit Log name the filters that actually let you reach older rows; Product Detail
  // and Supplier Detail have no such controls, so their hint only states the fact
  // ("more history than one page shows") rather than pointing at an action that isn't
  // there. Widening those two is the paging decision deferred in
  // docs/phase-11-plan.md §7.
  truncationNotice(count, noun, hint){
    return `<div class="inline-notice info" style="margin-bottom:14px">${UI.icon('history')}<div>Showing the most recent ${count} ${UI.esc(noun)}. ${UI.esc(hint)}</div></div>`;
  },
};
