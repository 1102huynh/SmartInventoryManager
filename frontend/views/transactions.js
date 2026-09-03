import { todayInputValue } from '../config.js';
import { isOwner } from '../session.js';
import { UI } from '../ui.js';
import { Store } from '../api.js';

// -------------------------------------------------------------- Transaction Wizard --
// Shared by Stock In (FR-020), Stock Out (FR-021), and Adjustment (FR-022) — the three
// are really one "record a transaction" flow with different fields, so one function
// handles all three rather than duplicating the step machinery three times.
const REASON_OPTIONS = [
  ['stocktake', 'Stocktake discrepancy'],
  ['damaged', 'Damaged'],
  ['lost', 'Lost / theft'],
  ['correction', 'Data-entry correction'],
  ['other', 'Other'],
];
const TITLES = { 'stock-in': 'Stock In', 'stock-out': 'Stock Out', 'adjustment': 'Adjust Stock' };

export function transactionWizard(container, productId, type){
  let product = null;
  let activeSuppliers = []; // only fetched/used for type === 'stock-in'
  let step = 'form'; // form | review | success
  let saving = false;
  let savedTx = null;
  // Phase 12: a Staff-initiated adjustment is a request an Owner must approve — so the
  // review step's wording and the wizard's final panel both change. False for the Owner
  // path and for stock-in/out. `sentForApproval` becomes true once the request is filed.
  const adjustmentNeedsApproval = type === 'adjustment' && !isOwner();
  let sentForApproval = false;
  const form = {
    quantity: '', newQty: '', date: todayInputValue(), supplierId: '',
    reason: '', reasonCategory: '', reasonOther: '',
  };
  let errors = {};

  // Both the product (for its name/unit/currentStock/status) and, for stock-in, the
  // active-supplier list have to be fetched before there's a form to show at all —
  // Phase 1 had both sitting in local arrays already, so this loading step didn't
  // exist yet.
  function load(){
    container.innerHTML = `<div class="skeleton skeleton-line" style="width:220px;height:24px"></div>`;
    Promise.all([
      Store.getProduct(productId),
      type === 'stock-in' ? Store.listSuppliers({ status: 'active' }) : Promise.resolve([]),
    ]).then(([p, suppliers]) => {
      product = p; activeSuppliers = suppliers;
      render();
    }).catch(err => { container.innerHTML = UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function render(){
    if (product.status !== 'active' && type !== 'adjustment'){
      container.innerHTML = `
        <div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/products/${product.id}">${UI.esc(product.name)}</a> / ${TITLES[type]}</div>
        <div class="inline-notice warn">${UI.icon('warning')}<div><strong>${UI.esc(product.name)}</strong> is inactive. Reactivate it from the product page before recording stock in or out.</div></div>
        <div style="margin-top:16px"><a class="btn btn-secondary" href="#/products/${product.id}">Back to Product</a></div>`;
      return;
    }
    if (step === 'form') container.innerHTML = crumbs() + steps() + formHtml();
    else if (step === 'review') container.innerHTML = crumbs() + steps() + reviewHtml();
    else container.innerHTML = crumbs() + successHtml();
    attach();
  }

  function crumbs(){
    return `<div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/products/${product.id}">${UI.esc(product.name)}</a> / ${TITLES[type]}</div>`;
  }
  function steps(){
    const s = step;
    const st = (key, n, label) => `<div class="step ${s===key?'active':(s==='review'&&key==='form')?'done':''}"><div class="dot">${(s==='review'&&key==='form') ? '✓' : n}</div>${label}</div>`;
    return `<div class="wizard-steps">${st('form',1,'Enter Details')}<div class="sep"></div>${st('review',2,'Review &amp; Confirm')}</div>`;
  }

  function formHtml(){
    const current = product.currentStock;
    return `<div class="wizard-wrap">
      <div class="card card-pad">
        <p style="margin-bottom:16px;color:var(--ink-muted);font-size:.85rem">Current stock: <strong class="tnum" style="color:var(--ink)">${current} ${UI.esc(product.unit)}</strong></p>
        <form id="wizard-form" novalidate>
          ${type === 'adjustment' ? adjustmentFields() : inOutFields(activeSuppliers)}
          <div class="field${errors.date ? ' has-error' : ''}">
            <label>Date <span class="req">*</span></label>
            <input type="date" id="f-date" value="${UI.esc(form.date)}" max="${todayInputValue()}">
            ${errors.date ? `<div class="error">${errors.date}</div>` : ''}
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Continue to Review</button>
            <a class="btn btn-secondary" href="#/products/${product.id}">Cancel</a>
          </div>
        </form>
      </div>
    </div>`;
  }

  function inOutFields(activeSuppliers){
    return `
      <div class="field${errors.quantity ? ' has-error' : ''}">
        <label>Quantity (${UI.esc(product.unit)}) <span class="req">*</span></label>
        <input type="number" id="f-quantity" min="1" step="1" value="${UI.esc(form.quantity)}" placeholder="0">
        ${errors.quantity ? `<div class="error">${errors.quantity}</div>` : `<div class="hint">Enter a whole number greater than 0.</div>`}
      </div>
      ${type === 'stock-in' ? `
      <div class="field">
        <label>Supplier</label>
        <select id="f-supplier">
          <option value="">— No supplier recorded —</option>
          ${activeSuppliers.map(s => `<option value="${s.id}" ${s.id===form.supplierId?'selected':''}>${UI.esc(s.name)}</option>`).join('')}
        </select>
        <div class="hint">Optional — inactive suppliers can't be selected (FR-013).</div>
      </div>` : `
      <div class="field">
        <label>Reason</label>
        <input type="text" id="f-reason" value="${UI.esc(form.reason)}" placeholder="Optional, e.g. Sold at counter">
      </div>`}
    `;
  }

  function adjustmentFields(){
    const current = product.currentStock;
    return `
      <div class="field${errors.newQty ? ' has-error' : ''}">
        <label>New Counted Quantity (${UI.esc(product.unit)}) <span class="req">*</span></label>
        <input type="number" id="f-newqty" min="0" step="1" value="${UI.esc(form.newQty)}" placeholder="${current}">
        ${errors.newQty ? `<div class="error">${errors.newQty}</div>` : `<div class="hint">Enter the actual physical count — the change is calculated for you.</div>`}
      </div>
      <div class="field${errors.reasonCategory ? ' has-error' : ''}">
        <label>Reason <span class="req">*</span></label>
        <select id="f-reason-cat">
          <option value="">— Select a reason —</option>
          ${REASON_OPTIONS.map(([v,l]) => `<option value="${v}" ${v===form.reasonCategory?'selected':''}>${l}</option>`).join('')}
        </select>
        ${errors.reasonCategory ? `<div class="error">${errors.reasonCategory}</div>` : ''}
      </div>
      ${form.reasonCategory === 'other' ? `
      <div class="field${errors.reasonOther ? ' has-error' : ''}">
        <label>Describe the Reason <span class="req">*</span></label>
        <input type="text" id="f-reason-other" value="${UI.esc(form.reasonOther)}" placeholder="e.g. Vendor shipped 2 extra units">
        ${errors.reasonOther ? `<div class="error">${errors.reasonOther}</div>` : ''}
      </div>` : ''}
    `;
  }

  function computeDelta(){
    const current = product.currentStock;
    if (type === 'adjustment') return Number(form.newQty) - current;
    const q = Number(form.quantity);
    return type === 'stock-out' ? -q : q;
  }

  function reviewHtml(){
    const current = product.currentStock;
    const delta = computeDelta();
    const after = current + delta;
    const reasonText = type === 'adjustment'
      ? (form.reasonCategory === 'other' ? form.reasonOther : (REASON_OPTIONS.find(r => r[0] === form.reasonCategory) || [,''])[1])
      : form.reason;
    const supplierName = form.supplierId ? activeSuppliers.find(s => String(s.id) === String(form.supplierId))?.name : null;
    return `<div class="wizard-wrap">
      <div class="card card-pad">
        <div class="review-card">
          <div class="review-row"><span class="k">Product</span><span class="v">${UI.esc(product.name)}</span></div>
          <div class="review-row"><span class="k">Type</span><span class="v">${TITLES[type]}</span></div>
          <div class="review-row"><span class="k">Date</span><span class="v">${UI.esc(form.date)}</span></div>
          ${type === 'stock-in' ? `<div class="review-row"><span class="k">Supplier</span><span class="v">${supplierName ? UI.esc(supplierName) : 'None recorded'}</span></div>` : ''}
          ${reasonText ? `<div class="review-row"><span class="k">Reason</span><span class="v">${UI.esc(reasonText)}</span></div>` : ''}
        </div>
        <div class="review-highlight">
          <div><div class="cell-sub">Before</div><div class="tnum" style="font-weight:700">${current} ${UI.esc(product.unit)}</div></div>
          <div class="arrow">→</div>
          <div><div class="cell-sub">Change</div><div class="tnum ${delta>0?'qty-pos':'qty-neg'}" style="font-weight:700">${UI.fmtQty(delta, '')}</div></div>
          <div class="arrow">→</div>
          <div><div class="cell-sub">${adjustmentNeedsApproval ? 'If approved' : 'After'}</div><div class="tnum" style="font-weight:700">${after} ${UI.esc(product.unit)}</div></div>
        </div>
        ${adjustmentNeedsApproval ? `<div class="inline-notice info" style="margin:4px 0 14px">${UI.icon('history')}<div>This will be sent to an Owner for approval. Stock does not change until it is approved.</div></div>` : ''}
        <div class="form-actions">
          <button class="btn btn-primary" id="btn-confirm" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : (adjustmentNeedsApproval ? 'Submit for Approval' : 'Confirm & Save')}</button>
          <button class="btn btn-secondary" id="btn-back">Back</button>
        </div>
      </div>
    </div>`;
  }

  function successHtml(){
    // Phase 12 (docs/phase-12-plan.md §3 item 1): the Adjustment path now has two
    // outcomes. A Staff member's adjustment did not change stock — it is a pending
    // request an Owner will review — so telling them it was "recorded" would be the
    // wrong-data-that-looks-right failure this project keeps refusing. The Owner path
    // and stock-in/out are unchanged.
    if (sentForApproval){
      return `<div class="wizard-wrap">
        <div class="success-panel">
          <div class="icon-circle">${UI.icon('history')}</div>
          <h3>Sent for approval</h3>
          <p>An Owner will review this count of <strong class="tnum">${UI.esc(form.newQty)} ${UI.esc(product.unit)}</strong> for ${UI.esc(product.name)}. Stock does not change until it is approved.</p>
          <div class="form-actions">
            <a class="btn btn-primary" href="#/approvals">View My Requests</a>
            <a class="btn btn-secondary" href="#/products/${product.id}">Back to Product</a>
          </div>
        </div>
      </div>`;
    }
    // product was re-fetched right after the save succeeded (see the confirm handler
    // below), so product.currentStock here is already the real post-transaction
    // total from the server — not a client-side + delta guess.
    const after = product.currentStock;
    return `<div class="wizard-wrap">
      <div class="success-panel">
        <div class="icon-circle">${UI.icon('check')}</div>
        <h3>${TITLES[type]} recorded</h3>
        <p>${UI.esc(product.name)} is now at <strong class="tnum">${after} ${UI.esc(product.unit)}</strong>.</p>
        <div class="form-actions">
          <a class="btn btn-primary" href="#/products/${product.id}">Back to Product</a>
          <button class="btn btn-secondary" id="btn-again">Record Another ${TITLES[type]}</button>
        </div>
      </div>
    </div>`;
  }

  function readForm(){
    if (type === 'adjustment'){
      form.newQty = container.querySelector('#f-newqty').value;
      form.reasonCategory = container.querySelector('#f-reason-cat').value;
      const other = container.querySelector('#f-reason-other');
      if (other) form.reasonOther = other.value;
    } else {
      form.quantity = container.querySelector('#f-quantity').value;
      if (type === 'stock-in') form.supplierId = container.querySelector('#f-supplier').value;
      else form.reason = container.querySelector('#f-reason').value;
    }
    form.date = container.querySelector('#f-date').value;
  }

  function validate(){
    const e = {};
    const current = product.currentStock;
    if (type === 'adjustment'){
      const n = Number(form.newQty);
      if (form.newQty === '' || !Number.isInteger(n) || n < 0) e.newQty = 'Enter a whole number, 0 or greater.';
      if (!form.reasonCategory) e.reasonCategory = 'Select a reason.';
      else if (form.reasonCategory === 'other' && !form.reasonOther.trim()) e.reasonOther = 'Describe the reason.';
    } else {
      const n = Number(form.quantity);
      if (form.quantity === '' || !Number.isInteger(n) || n <= 0) e.quantity = 'Enter a whole number greater than 0.';
      else if (type === 'stock-out' && n > current) e.quantity = `Only ${current} ${product.unit} available — cannot remove ${n}.`;
    }
    if (!form.date) e.date = 'Select a date.';
    else if (form.date > todayInputValue()) e.date = 'Date cannot be in the future.';
    return e;
  }

  function attach(){
    if (step === 'form'){
      const f = container.querySelector('#wizard-form');
      f.addEventListener('submit', ev => {
        ev.preventDefault();
        readForm();
        errors = validate();
        if (Object.keys(errors).length){ render(); return; }
        step = 'review'; render();
      });
      const rc = container.querySelector('#f-reason-cat');
      // Sync every field from the DOM before re-rendering — otherwise the fields we
      // don't explicitly track here (quantity/date already typed) would be wiped out
      // by the next render, which rebuilds the form HTML from `form` state.
      if (rc) rc.addEventListener('change', () => { readForm(); render(); container.querySelector('#f-reason-cat')?.focus(); });
    } else if (step === 'review'){
      container.querySelector('#btn-back').addEventListener('click', () => { step = 'form'; render(); });
      container.querySelector('#btn-confirm').addEventListener('click', () => {
        saving = true; render();
        // Phase 1 had one Store.createTransaction({ type, ... }) dispatcher; Phase 2
        // maps directly onto the three REST actions instead (POST .../stock-in,
        // .../stock-out, .../adjustments) — see Store, above.
        let call;
        if (type === 'stock-in') call = Store.recordStockIn(product.id, { quantity: form.quantity, date: form.date, supplierId: form.supplierId }).then(tx => ({ recorded: true, tx }));
        else if (type === 'stock-out') call = Store.recordStockOut(product.id, { quantity: form.quantity, date: form.date, reason: form.reason }).then(tx => ({ recorded: true, tx }));
        // Phase 12: recordAdjustment resolves to a discriminated result. `requested`
        // means a Staff member's count is now a pending request that changed no stock.
        else call = Store.recordAdjustment(product.id, {
          newQty: form.newQty, date: form.date,
          reason: form.reasonCategory === 'other' ? form.reasonOther : REASON_OPTIONS.find(r => r[0] === form.reasonCategory)[1],
        }).then(res => res.outcome === 'requested' ? { recorded: false } : { recorded: true, tx: res.transaction });
        call
          .then(async out => {
            if (out.recorded){
              // Re-fetch the product so successHtml's "now at N units" reflects the
              // server's authoritative post-transaction stock, not a client-side guess.
              product = await Store.getProduct(product.id);
              savedTx = out.tx;
              UI.toast(`${TITLES[type]} recorded for ${product.name}.`, 'success');
            } else {
              sentForApproval = true;
              UI.toast(`Adjustment sent to an Owner for approval.`, 'success');
            }
            saving = false; step = 'success';
            render();
          }).catch(err => { saving = false; UI.toast(err.message, 'error'); render(); });
      });
    } else {
      const again = container.querySelector('#btn-again');
      if (again) again.addEventListener('click', () => {
        step = 'form'; savedTx = null; sentForApproval = false; errors = {};
        form.quantity = ''; form.newQty = ''; form.date = todayInputValue();
        form.supplierId = ''; form.reason = ''; form.reasonCategory = ''; form.reasonOther = '';
        render();
      });
    }
  }

  load();
}

// -------------------------------------------------------------- Global History --
// FR-031: every transaction across every product, immutable (BR-051) — so this is a
// pure read/filter view with no edit or delete affordance anywhere on it.
export function historyView(container, query){
  let type = '';
  let productId = '';
  let days = '';
  let override = 'normal';
  // Populated once (see load()) to fill the "product" filter dropdown — Phase 1 had
  // this list in memory for free; Phase 2 fetches it once and reuses it across
  // filter changes instead of re-fetching on every load().
  let productOptions = [];

  function load(){
    container.innerHTML = header() + toolbar() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(6,7)}</tbody></table></div>`;
    attachHeaderHandlers();
    UI.mockFetch(async () => {
      if (override === 'empty') return { items: [], truncated: false };
      const [products, result] = await Promise.all([
        productOptions.length ? productOptions : Store.listProducts({}),
        Store.listAllTransactions({ type: type || undefined, productId: productId || undefined, days: days ? Number(days) : undefined }),
      ]);
      productOptions = products;
      return result;
    }, { forceState: override === 'error' ? 'error' : null })
      .then(result => { container.innerHTML = header() + toolbar() + body(result.items, result.truncated); attachAll(); })
      .catch(err => { container.innerHTML = header() + toolbar() + UI.errorState(err.message, 'retry'); attachAll(); });
  }

  function header(){
    return `<div class="content-header"><div><h1>Inventory History</h1><div class="sub">Every stock-in, stock-out, and adjustment across all products. Records are permanent — corrections happen only through a new adjustment.</div></div></div>`;
  }

  function toolbar(){
    return `<div class="toolbar">
      <select class="select-filter" id="h-type">
        <option value="">All types</option>
        <option value="stock-in" ${type==='stock-in'?'selected':''}>Stock In</option>
        <option value="stock-out" ${type==='stock-out'?'selected':''}>Stock Out</option>
        <option value="adjustment" ${type==='adjustment'?'selected':''}>Adjustment</option>
      </select>
      <select class="select-filter" id="h-product">
        <option value="">All products</option>
        ${productOptions.map(p => `<option value="${p.id}" ${String(p.id)===String(productId)?'selected':''}>${UI.esc(p.name)}</option>`).join('')}
      </select>
      <select class="select-filter" id="h-days">
        <option value="">All time</option>
        <option value="7" ${days==='7'?'selected':''}>Last 7 days</option>
        <option value="30" ${days==='30'?'selected':''}>Last 30 days</option>
        <option value="90" ${days==='90'?'selected':''}>Last 90 days</option>
      </select>
      ${UI.previewControl(override)}
    </div>`;
  }

  function body(list, truncated){
    if (list.length === 0){
      return UI.emptyState(override === 'empty' ? 'No transactions recorded' : 'No matching transactions', override === 'empty' ? 'Stock movements will appear here once recorded.' : 'Try a different filter combination.');
    }
    // Phase 11 (docs/phase-11-plan.md §3): without this line, a shop open two years
    // sees a history that silently stops in the middle of last month.
    const notice = truncated
      ? UI.truncationNotice(list.length, 'movements', 'Narrow the range or filter by product to see more.')
      : '';
    return `${notice}<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Product</th><th>Type</th><th>Qty</th><th>Supplier / Reason</th><th>By</th></tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody>
    </table></div>`;
  }

  function rowHtml(t){
    const detail = t.type === 'stock-in'
      ? (t.supplier ? UI.esc(t.supplier.name) : '<span class="cell-sub">No supplier recorded</span>')
      : (t.reason ? UI.esc(t.reason) : '<span class="cell-sub">—</span>');
    return `<tr class="clickable" data-goto="#/products/${t.productId}">
      <td class="cell-sub">${UI.fmtDateTime(t.date)}</td>
      <td class="cell-name">${UI.esc(t.product ? t.product.name : 'Unknown')}</td>
      <td>${UI.typeBadge(t.type)}</td>
      <td class="tnum ${t.delta>0?'qty-pos':'qty-neg'}">${UI.fmtQty(t.delta, t.product ? t.product.unit : '')}</td>
      <td>${detail}</td>
      <td class="cell-sub">${t.recordedBy ? UI.esc(t.recordedBy.name) : '—'}</td>
    </tr>`;
  }

  function attachHeaderHandlers(){
    const t = container.querySelector('#h-type'); if (t) t.addEventListener('change', e => { type = e.target.value; load(); });
    const p = container.querySelector('#h-product'); if (p) p.addEventListener('change', e => { productId = e.target.value; load(); });
    const d = container.querySelector('#h-days'); if (d) d.addEventListener('change', e => { days = e.target.value; load(); });
    const pr = container.querySelector('#preview-select'); if (pr) pr.addEventListener('change', e => { override = e.target.value; load(); });
  }
  function attachAll(){
    attachHeaderHandlers();
    container.querySelectorAll('[data-goto]').forEach(row => row.addEventListener('click', () => UI.navigate(row.dataset.goto)));
    const retry = container.querySelector('#retry'); if (retry) retry.addEventListener('click', () => { override = 'normal'; load(); });
  }

  load();
}
