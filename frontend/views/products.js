import { isOwner } from '../session.js';
import { getCategories, getCategory } from '../reference-data.js';
import { UI } from '../ui.js';
import { Store } from '../api.js';

// -------------------------------------------------------------- Product List --
// FR-004 (list & status), FR-042 (low-stock list, via the status filter rather than
// a separate screen — see the UI Decisions write-up for why).
export function productList(container, query){
  let search = '';
  let status = query.get('status') || 'all'; // all | active | inactive | low | out
  let category = query.get('category') || '';
  let override = 'normal';

  function load(){
    container.innerHTML = header() + toolbar() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(6,6)}</tbody></table></div>`;
    attachHeaderHandlers();
    UI.mockFetch(() => {
      if (override === 'empty') return [];
      // low/out used to be filtered client-side after fetching everything; the API's
      // ?status= now accepts them directly (ProductsService.findAll), so the server
      // does the filtering instead of the browser.
      return Store.listProducts({ search, category: category || undefined, status: status === 'all' ? undefined : status });
    }, { forceState: override === 'error' ? 'error' : null })
      .then(list => { container.innerHTML = header() + toolbar() + body(list); attachAll(); })
      .catch(err => { container.innerHTML = header() + toolbar() + UI.errorState(err.message, 'retry'); attachAll(); });
  }

  function header(){
    // Phase 1 showed a live "N products in the catalog" count here for free (it was
    // just PRODUCTS.length). That count isn't part of any response this screen
    // fetches, and firing an extra unfiltered request purely to caption the page
    // isn't worth it — so the subtitle becomes static copy instead.
    return `<div class="content-header">
      <div><h1>Products</h1><div class="sub">Your full product catalog.</div></div>
      <div class="header-actions">${isOwner() ? `<a class="btn btn-primary" href="#/products/new">${UI.icon('plus')} New Product</a>` : ''}</div>
    </div>`;
  }

  function toolbar(){
    const statusLabel = { all:'All', active:'Active', inactive:'Inactive', low:'Low Stock', out:'Out of Stock' };
    return `<div class="toolbar">
      <div class="search-input">${UI.icon('search')}<input type="text" id="pl-search" placeholder="Search by name or SKU" value="${UI.esc(search)}"></div>
      <select class="select-filter" id="pl-status">
        ${Object.entries(statusLabel).map(([v,l]) => `<option value="${v}" ${v===status?'selected':''}>${l}</option>`).join('')}
      </select>
      <select class="select-filter" id="pl-category">
        <option value="">All categories</option>
        ${getCategories().map(c => `<option value="${c.id}" ${c.id===category?'selected':''}>${UI.esc(c.name)}</option>`).join('')}
      </select>
      ${isOwner() ? '<a class="btn btn-ghost btn-sm" href="#/categories">Manage categories</a>' : ''}
      ${UI.previewControl(override)}
    </div>`;
  }

  function body(list){
    if (list.length === 0){
      if (override === 'empty') return UI.emptyState('No products yet', 'Add your first product to start tracking stock.');
      return UI.emptyState('No matching products', 'Try a different search term or clear the filters.');
    }
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Product</th><th>Category</th><th>Stock</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody>
    </table></div>`;
  }

  function rowHtml(p){
    return `<tr class="clickable" data-goto="#/products/${p.id}">
      <td><div class="cell-name">${UI.esc(p.name)}</div><div class="cell-sub mono">${UI.esc(p.sku)}</div></td>
      <td>${UI.catChip(p.categoryId)}</td>
      <td class="tnum">${p.currentStock} ${UI.esc(p.unit)}</td>
      <td>${UI.badgeStatus(p.status)} ${UI.badgeStockLevel(p)}</td>
      <td><a class="btn btn-ghost btn-sm" href="#/products/${p.id}">View</a></td>
    </tr>`;
  }

  function attachHeaderHandlers(){
    const s = container.querySelector('#pl-status');
    if (s) s.addEventListener('change', e => { status = e.target.value; load(); });
    const c = container.querySelector('#pl-category');
    if (c) c.addEventListener('change', e => { category = e.target.value; load(); });
    const p = container.querySelector('#preview-select');
    if (p) p.addEventListener('change', e => { override = e.target.value; load(); });
  }

  function attachAll(){
    attachHeaderHandlers();
    const searchInput = container.querySelector('#pl-search');
    if (searchInput){
      searchInput.addEventListener('input', e => { search = e.target.value; load(); });
      searchInput.focus();
      const val = searchInput.value; searchInput.value = ''; searchInput.value = val;
    }
    container.querySelectorAll('[data-goto]').forEach(row => row.addEventListener('click', () => UI.navigate(row.dataset.goto)));
    const retry = container.querySelector('#retry');
    if (retry) retry.addEventListener('click', () => { override = 'normal'; load(); });
  }

  load();
}

// -------------------------------------------------------------- Product Detail --
// FR-004 (detail), FR-030 (per-product history), FR-006/BR-004 (no delete with history).
export function productDetail(container, id){
  let product = null;
  let history = [];
  let historyTruncated = false;
  let confirmMode = null; // null | 'deactivate' | 'delete'

  // Phase 1 read `product` and its history synchronously off local arrays and never
  // needed to reload them — every mutation just edited the array in place. Phase 2
  // re-fetches both from the API after every mutation instead of hand-patching local
  // state: one extra round trip per action, but it guarantees what's on screen is
  // exactly what the server just committed (including currentStock/lowStock, which
  // only the server can compute).
  function load(){
    container.innerHTML = `<div class="skeleton skeleton-line" style="width:220px;height:24px"></div>`;
    Promise.all([Store.getProduct(id), Store.listTransactionsForProduct(id)])
      .then(([p, h]) => { product = p; history = h.items; historyTruncated = h.truncated; render(); })
      .catch(err => { container.innerHTML = UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function render(){
    const cat = getCategory(product.categoryId);
    const inactive = product.status !== 'active';

    container.innerHTML = `
      <div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/products">Products</a> / ${UI.esc(product.name)}</div>
      <div class="detail-hero">
        <div>
          <h1>${UI.esc(product.name)} ${UI.badgeStatus(product.status)} ${UI.badgeStockLevel(product)}</h1>
          <div class="detail-id mono">${UI.esc(product.sku)} · ${cat ? UI.esc(cat.name) : 'Uncategorized'}</div>
          <div class="detail-stock"><span class="num tnum">${product.currentStock}</span><span class="unit">${UI.esc(product.unit)} on hand</span></div>
          <div class="detail-meta">
            <div><span class="k">Low-stock threshold</span>${product.lowStockThreshold === null ? 'Not set — never flagged' : product.lowStockThreshold + ' ' + UI.esc(product.unit)}</div>
            <div><span class="k">Category</span>${cat ? UI.esc(cat.name) : '—'}</div>
            ${UI.auditMetaHtml(product)}
          </div>
        </div>
        <div class="header-actions">${isOwner() ? `<a class="btn btn-secondary" href="#/products/${product.id}/edit">Edit</a>` : ''}</div>
      </div>

      ${inactive ? `<div class="inline-notice warn" style="margin-bottom:20px">${UI.icon('warning')}<div>This product is <strong>inactive</strong>. Reactivate it to record stock-in or stock-out — adjustments are still allowed (e.g. to finalize a closing count).</div></div>` : ''}

      <div class="action-row">
        <a class="btn btn-primary" ${inactive ? 'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"' : `href="#/products/${product.id}/stock-in"`}>Stock In</a>
        <a class="btn btn-secondary" ${inactive ? 'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"' : `href="#/products/${product.id}/stock-out"`}>Stock Out</a>
        <a class="btn btn-secondary" href="#/products/${product.id}/adjust">Adjust Stock</a>
        <span style="flex:1"></span>
        ${isOwner() ? lifecycleControls(inactive) : ''}
      </div>

      <h2 class="section-title">Transaction History</h2>
      ${historyTruncated ? UI.truncationNotice(history.length, 'movements', 'This product has more history than one page shows.') : ''}
      ${history.length > 0 ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Supplier / Reason</th><th>By</th></tr></thead>
        <tbody>${history.map(historyRow).join('')}</tbody>
      </table></div>` : UI.emptyState('No transactions yet', 'This product was just added — record a Stock In to receive its first units.')}
    `;
    attach();
  }

  function lifecycleControls(inactive){
    if (confirmMode === 'deactivate'){
      return `<div class="confirm-inline">Deactivate ${UI.esc(product.name)}? It will be hidden from new stock-in/out.
        <button class="btn btn-ghost btn-sm" id="cancel-confirm">Cancel</button>
        <button class="btn btn-danger btn-sm" id="do-deactivate">Yes, deactivate</button></div>`;
    }
    if (confirmMode === 'delete'){
      return `<div class="confirm-inline">Permanently delete ${UI.esc(product.name)}? This cannot be undone.
        <button class="btn btn-ghost btn-sm" id="cancel-confirm">Cancel</button>
        <button class="btn btn-danger btn-sm" id="do-delete">Yes, delete</button></div>`;
    }
    const toggle = inactive
      ? `<button class="btn btn-secondary" id="btn-activate">Reactivate</button>`
      : `<button class="btn btn-secondary" id="btn-deactivate">Deactivate</button>`;
    const del = product.hasHistory
      ? `<button class="btn btn-danger" disabled title="Products with transaction history can't be deleted — deactivate instead">Delete</button>`
      : `<button class="btn btn-danger" id="btn-delete">Delete</button>`;
    return toggle + del;
  }

  // t.supplier/t.recordedBy arrive pre-normalized (see normalizeTx) from the API's
  // joined relations — no separate Store.getSupplier/getUser lookups needed anymore.
  function historyRow(t){
    const detail = t.type === 'stock-in'
      ? (t.supplier ? UI.esc(t.supplier.name) : '<span class="cell-sub">No supplier recorded</span>')
      : (t.reason ? UI.esc(t.reason) : '<span class="cell-sub">—</span>');
    return `<tr>
      <td class="cell-sub">${UI.fmtDateTime(t.date)}</td>
      <td>${UI.typeBadge(t.type)}</td>
      <td class="tnum ${t.delta > 0 ? 'qty-pos' : 'qty-neg'}">${UI.fmtQty(t.delta, product.unit)}</td>
      <td>${detail}</td>
      <td class="cell-sub">${t.recordedBy ? UI.esc(t.recordedBy.name) : '—'}</td>
    </tr>`;
  }

  function attach(){
    const cancel = container.querySelector('#cancel-confirm');
    if (cancel) cancel.addEventListener('click', () => { confirmMode = null; render(); });
    const deact = container.querySelector('#btn-deactivate');
    if (deact) deact.addEventListener('click', () => { confirmMode = 'deactivate'; render(); });
    const doDeact = container.querySelector('#do-deactivate');
    if (doDeact) doDeact.addEventListener('click', () => {
      Store.setProductStatus(product.id, 'inactive')
        .then(() => { confirmMode = null; UI.toast(`${product.name} deactivated.`); return load(); })
        .catch(err => UI.toast(err.message, 'error'));
    });
    const act = container.querySelector('#btn-activate');
    if (act) act.addEventListener('click', () => {
      Store.setProductStatus(product.id, 'active')
        .then(() => { UI.toast(`${product.name} reactivated.`, 'success'); return load(); })
        .catch(err => UI.toast(err.message, 'error'));
    });
    const del = container.querySelector('#btn-delete');
    if (del) del.addEventListener('click', () => { confirmMode = 'delete'; render(); });
    const doDel = container.querySelector('#do-delete');
    if (doDel) doDel.addEventListener('click', () => {
      Store.deleteProduct(product.id)
        .then(() => { UI.toast(`${product.name} deleted.`, 'success'); UI.navigate('#/products'); })
        .catch(err => { confirmMode = null; UI.toast(err.message, 'error'); render(); });
    });
  }

  load();
}

// -------------------------------------------------------------- Product Form --
// FR-001 (create), FR-002 (edit — SKU locked once history exists, per BR-001).
export function productForm(container, id){
  const editing = !!id;
  let product = null;
  let skuLocked = false;
  const state = { name: '', sku: '', unit: '', categoryId: '', threshold: '' };
  let errors = {};

  // Editing needs the product fetched first (for its current values AND its
  // hasHistory flag, which decides skuLocked) before there's anything to render;
  // creating doesn't need a fetch at all.
  function load(){
    if (!editing){ render(); return; }
    container.innerHTML = `<div class="skeleton skeleton-line" style="width:220px;height:24px"></div>`;
    Store.getProduct(id).then(p => {
      product = p;
      skuLocked = p.hasHistory;
      state.name = p.name; state.sku = p.sku; state.unit = p.unit;
      state.categoryId = p.categoryId || '';
      state.threshold = p.lowStockThreshold !== null ? String(p.lowStockThreshold) : '';
      render();
    }).catch(err => { container.innerHTML = UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function render(){
    container.innerHTML = `
      <div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/products">Products</a> / ${editing ? UI.esc(product.name) : 'New Product'}</div>
      <div class="content-header"><div><h1>${editing ? 'Edit Product' : 'New Product'}</h1>
        <div class="sub">${editing ? 'SKU and identity details.' : 'Every product needs a name, SKU, and unit of measurement before it can be used in a transaction.'}</div></div></div>
      <div class="card card-pad" style="max-width:640px">
        <form id="product-form" novalidate>
          <div class="form-grid">
            <div class="field${errors.name ? ' has-error' : ''}">
              <label>Name <span class="req">*</span></label>
              <input type="text" id="f-name" value="${UI.esc(state.name)}" placeholder="e.g. Espresso Beans, 1kg">
              ${errors.name ? `<div class="error">${errors.name}</div>` : ''}
            </div>
            <div class="field${errors.sku ? ' has-error' : ''}">
              <label>SKU <span class="req">*</span></label>
              <input type="text" id="f-sku" value="${UI.esc(state.sku)}" placeholder="e.g. CO-1001" ${skuLocked ? 'disabled' : ''}>
              ${skuLocked ? `<div class="hint">Locked — this product has transaction history (BR-001).</div>` : ''}
              ${errors.sku ? `<div class="error">${errors.sku}</div>` : ''}
            </div>
          </div>
          <div class="form-grid">
            <div class="field${errors.unit ? ' has-error' : ''}">
              <label>Unit of Measurement <span class="req">*</span></label>
              <input type="text" id="f-unit" value="${UI.esc(state.unit)}" placeholder="e.g. bag, box, case">
              ${errors.unit ? `<div class="error">${errors.unit}</div>` : ''}
            </div>
            <div class="field">
              <label>Category</label>
              <select id="f-category">
                <option value="">— None —</option>
                ${getCategories().map(c => `<option value="${c.id}" ${c.id===state.categoryId?'selected':''}>${UI.esc(c.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field${errors.threshold ? ' has-error' : ''}" style="max-width:260px">
            <label>Low-Stock Threshold</label>
            <input type="number" id="f-threshold" min="0" step="1" value="${UI.esc(state.threshold)}" placeholder="Leave blank for none">
            <div class="hint">Flagged low-stock when stock falls at or below this number. Leave blank to never flag this product.</div>
            ${errors.threshold ? `<div class="error">${errors.threshold}</div>` : ''}
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${editing ? 'Save Changes' : 'Create Product'}</button>
            <a class="btn btn-secondary" href="${editing ? '#/products/' + product.id : '#/products'}">Cancel</a>
          </div>
        </form>
      </div>`;
    attach();
  }

  function readForm(){
    state.name = container.querySelector('#f-name').value;
    state.sku = skuLocked ? state.sku : container.querySelector('#f-sku').value;
    state.unit = container.querySelector('#f-unit').value;
    state.categoryId = container.querySelector('#f-category').value;
    state.threshold = container.querySelector('#f-threshold').value;
  }

  function validate(){
    // SKU uniqueness used to be checked here too (Store.skuExists against the local
    // PRODUCTS array). Uniqueness is a database constraint now (BR-001 — see the
    // unique index in the InitSchema migration), so it can only be checked by
    // actually asking the server; see the submit handler's .catch() below for how
    // that 409 becomes an inline field error instead of just a toast.
    const e = {};
    if (!state.name.trim()) e.name = 'Name is required.';
    if (!state.sku.trim()) e.sku = 'SKU is required.';
    if (!state.unit.trim()) e.unit = 'Unit of measurement is required.';
    if (state.threshold !== '' && (!Number.isInteger(Number(state.threshold)) || Number(state.threshold) < 0)) {
      e.threshold = 'Enter a whole number, 0 or greater, or leave blank.';
    }
    return e;
  }

  function attach(){
    container.querySelector('#product-form').addEventListener('submit', e => {
      e.preventDefault();
      readForm();
      errors = validate();
      if (Object.keys(errors).length){ render(); return; }
      const submitBtn = container.querySelector('#product-form button[type=submit]');
      submitBtn.disabled = true;
      const save = editing ? Store.updateProduct(id, state) : Store.createProduct(state);
      save.then(result => {
        UI.toast(editing ? 'Product updated.' : 'Product created.', 'success');
        UI.navigate('#/products/' + (editing ? id : result.id));
      }).catch(err => {
        errors = /sku/i.test(err.message) ? { sku: err.message } : {};
        if (Object.keys(errors).length === 0) UI.toast(err.message, 'error');
        render();
      });
    });
  }

  load();
}
