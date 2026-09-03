import { isOwner } from '../session.js';
import { UI } from '../ui.js';
import { Store } from '../api.js';

// -------------------------------------------------------------- Supplier List --
// FR-012/FR-013.
export function supplierList(container, query){
  let search = '';
  let status = '';
  let override = 'normal';

  function load(){
    container.innerHTML = header() + toolbar() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(4,4)}</tbody></table></div>`;
    attachHeaderHandlers();
    UI.mockFetch(() => override === 'empty' ? [] : Store.listSuppliers({ search, status: status || undefined }),
      { forceState: override === 'error' ? 'error' : null })
      .then(list => { container.innerHTML = header() + toolbar() + body(list); attachAll(); })
      .catch(err => { container.innerHTML = header() + toolbar() + UI.errorState(err.message, 'retry'); attachAll(); });
  }

  function header(){
    return `<div class="content-header">
      <div><h1>Suppliers</h1><div class="sub">Every supplier on file.</div></div>
      <div class="header-actions">${isOwner() ? `<a class="btn btn-primary" href="#/suppliers/new">${UI.icon('plus')} New Supplier</a>` : ''}</div>
    </div>`;
  }
  function toolbar(){
    return `<div class="toolbar">
      <div class="search-input">${UI.icon('search')}<input type="text" id="sl-search" placeholder="Search suppliers" value="${UI.esc(search)}"></div>
      <select class="select-filter" id="sl-status">
        <option value="">All</option>
        <option value="active" ${status==='active'?'selected':''}>Active</option>
        <option value="inactive" ${status==='inactive'?'selected':''}>Inactive</option>
      </select>
      ${UI.previewControl(override)}
    </div>`;
  }
  function body(list){
    if (list.length === 0) return UI.emptyState(override==='empty' ? 'No suppliers yet' : 'No matching suppliers', override==='empty' ? 'Add a supplier to start linking them to stock-in.' : 'Try a different search or filter.');
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Supplier</th><th>Contact</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(s => `<tr class="clickable" data-goto="#/suppliers/${s.id}">
        <td class="cell-name">${UI.esc(s.name)}</td>
        <td><div>${UI.esc(s.contactName || '—')}</div><div class="cell-sub">${UI.esc(s.email || '')}</div></td>
        <td>${UI.badgeStatus(s.status)}</td>
        <td><a class="btn btn-ghost btn-sm" href="#/suppliers/${s.id}">View</a></td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  function attachHeaderHandlers(){
    const s = container.querySelector('#sl-status'); if (s) s.addEventListener('change', e => { status = e.target.value; load(); });
    const p = container.querySelector('#preview-select'); if (p) p.addEventListener('change', e => { override = e.target.value; load(); });
  }
  function attachAll(){
    attachHeaderHandlers();
    const search_ = container.querySelector('#sl-search');
    if (search_){ search_.addEventListener('input', e => { search = e.target.value; load(); }); search_.focus(); const v = search_.value; search_.value=''; search_.value=v; }
    container.querySelectorAll('[data-goto]').forEach(row => row.addEventListener('click', () => UI.navigate(row.dataset.goto)));
    const retry = container.querySelector('#retry'); if (retry) retry.addEventListener('click', () => { override='normal'; load(); });
  }
  load();
}

// -------------------------------------------------------------- Supplier Detail --
export function supplierDetail(container, id){
  let supplier = null;
  let txs = [];
  let txsTruncated = false;
  let confirmMode = null;

  function load(){
    container.innerHTML = `<div class="skeleton skeleton-line" style="width:220px;height:24px"></div>`;
    Promise.all([Store.getSupplierById(id), Store.listTransactionsForSupplier(id)])
      .then(([s, t]) => { supplier = s; txs = t.items; txsTruncated = t.truncated; render(); })
      .catch(err => { container.innerHTML = UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function render(){
    container.innerHTML = `
      <div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/suppliers">Suppliers</a> / ${UI.esc(supplier.name)}</div>
      <div class="detail-hero">
        <div>
          <h1>${UI.esc(supplier.name)} ${UI.badgeStatus(supplier.status)}</h1>
          <div class="detail-meta">
            <div><span class="k">Contact</span>${UI.esc(supplier.contactName || '—')}</div>
            <div><span class="k">Email</span>${UI.esc(supplier.email || '—')}</div>
            <div><span class="k">Phone</span>${UI.esc(supplier.phone || '—')}</div>
            ${UI.auditMetaHtml(supplier)}
          </div>
        </div>
        <div class="header-actions">${isOwner() ? `<a class="btn btn-secondary" href="#/suppliers/${supplier.id}/edit">Edit</a>` : ''}</div>
      </div>
      <div class="action-row">
        ${!isOwner() ? '' : confirmMode === 'toggle' ? `<div class="confirm-inline">${supplier.status==='active' ? 'Deactivate' : 'Reactivate'} ${UI.esc(supplier.name)}?
            <button class="btn btn-ghost btn-sm" id="cancel-confirm">Cancel</button>
            <button class="btn btn-danger btn-sm" id="do-toggle">Confirm</button></div>`
          : `<button class="btn btn-secondary" id="btn-toggle">${supplier.status==='active' ? 'Deactivate' : 'Reactivate'}</button>`}
      </div>
      <h2 class="section-title">Stock Received From This Supplier</h2>
      ${txsTruncated ? UI.truncationNotice(txs.length, 'movements', 'This supplier has more history than one page shows.') : ''}
      ${txs.length === 0 ? UI.emptyState('No stock-in recorded', 'Transactions that reference this supplier will show up here.') : `
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Recorded By</th></tr></thead>
        <tbody>${txs.map(t => `<tr class="clickable" data-goto="#/products/${t.productId}">
            <td class="cell-sub">${UI.fmtDateTime(t.date)}</td>
            <td class="cell-name">${UI.esc(t.product ? t.product.name : 'Unknown')}</td>
            <td class="tnum qty-pos">${UI.fmtQty(t.delta, t.product ? t.product.unit : '')}</td>
            <td class="cell-sub">${t.recordedBy ? UI.esc(t.recordedBy.name) : '—'}</td>
          </tr>`).join('')}</tbody></table></div>`}
    `;
    attach();
  }
  function attach(){
    const cancel = container.querySelector('#cancel-confirm'); if (cancel) cancel.addEventListener('click', () => { confirmMode = null; render(); });
    const toggle = container.querySelector('#btn-toggle'); if (toggle) toggle.addEventListener('click', () => { confirmMode = 'toggle'; render(); });
    const doToggle = container.querySelector('#do-toggle'); if (doToggle) doToggle.addEventListener('click', () => {
      const next = supplier.status === 'active' ? 'inactive' : 'active';
      Store.setSupplierStatus(supplier.id, next)
        .then(() => { confirmMode = null; UI.toast(`${supplier.name} ${next === 'active' ? 'reactivated' : 'deactivated'}.`, 'success'); return load(); })
        .catch(err => UI.toast(err.message, 'error'));
    });
    container.querySelectorAll('[data-goto]').forEach(row => row.addEventListener('click', () => UI.navigate(row.dataset.goto)));
  }
  load();
}

// -------------------------------------------------------------- Supplier Form --
// FR-010/FR-011.
export function supplierForm(container, id){
  const editing = !!id;
  let supplier = null;
  const state = { name: '', contact: '', email: '', phone: '' };
  let errors = {};

  function load(){
    if (!editing){ render(); return; }
    container.innerHTML = `<div class="skeleton skeleton-line" style="width:220px;height:24px"></div>`;
    Store.getSupplierById(id).then(s => {
      supplier = s;
      state.name = s.name; state.contact = s.contactName || ''; state.email = s.email || ''; state.phone = s.phone || '';
      render();
    }).catch(err => { container.innerHTML = UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function render(){
    container.innerHTML = `
      <div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/suppliers">Suppliers</a> / ${editing ? UI.esc(supplier.name) : 'New Supplier'}</div>
      <div class="content-header"><div><h1>${editing ? 'Edit Supplier' : 'New Supplier'}</h1></div></div>
      <div class="card card-pad" style="max-width:640px">
        <form id="supplier-form" novalidate>
          <div class="field${errors.name ? ' has-error' : ''}">
            <label>Supplier Name <span class="req">*</span></label>
            <input type="text" id="f-name" value="${UI.esc(state.name)}" placeholder="e.g. Highland Roasters">
            ${errors.name ? `<div class="error">${errors.name}</div>` : ''}
          </div>
          <div class="form-grid">
            <div class="field"><label>Contact Name</label><input type="text" id="f-contact" value="${UI.esc(state.contact)}"></div>
            <div class="field${errors.email ? ' has-error' : ''}"><label>Email</label><input type="email" id="f-email" value="${UI.esc(state.email)}">${errors.email ? `<div class="error">${errors.email}</div>` : ''}</div>
          </div>
          <div class="field" style="max-width:260px"><label>Phone</label><input type="text" id="f-phone" value="${UI.esc(state.phone)}"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${editing ? 'Save Changes' : 'Create Supplier'}</button>
            <a class="btn btn-secondary" href="${editing ? '#/suppliers/' + supplier.id : '#/suppliers'}">Cancel</a>
          </div>
        </form>
      </div>`;
    attach();
  }
  function validate(){
    const e = {};
    if (!state.name.trim()) e.name = 'Supplier name is required.';
    if (state.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) e.email = 'Enter a valid email address.';
    return e;
  }
  function attach(){
    container.querySelector('#supplier-form').addEventListener('submit', e => {
      e.preventDefault();
      state.name = container.querySelector('#f-name').value;
      state.contact = container.querySelector('#f-contact').value;
      state.email = container.querySelector('#f-email').value;
      state.phone = container.querySelector('#f-phone').value;
      errors = validate();
      if (Object.keys(errors).length){ render(); return; }
      const save = editing ? Store.updateSupplier(id, state) : Store.createSupplier(state);
      save.then(result => {
        UI.toast(editing ? 'Supplier updated.' : 'Supplier created.', 'success');
        UI.navigate('#/suppliers/' + (editing ? id : result.id));
      }).catch(err => { UI.toast(err.message, 'error'); });
    });
  }
  load();
}
