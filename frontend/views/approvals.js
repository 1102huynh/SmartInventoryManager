import { isOwner, getCurrentUser } from '../session.js';
import { UI } from '../ui.js';
import { Store } from '../api.js';
import { updateApprovalsBadge } from '../router.js';

// -------------------------------------------------------------- Approvals --
// Phase 12 (docs/phase-12-plan.md §3). Modeled on Views.auditLog — a filtered,
// newest-first table with a toolbar of <select>s — since a stream of requests that
// grows with the business is the same shape as a log. NOT gated by isOwnerOnlyRoute
// in renderApp(): BR-073 keeps reads open to both roles, and a Staff member who
// submitted a count needs to see whether it was accepted — so the nav item shows for
// both roles too (only the pending-count badge on it is Owner-only). Owners see
// Approve/Reject row actions and the whole queue; Staff see a read-only list scoped to
// their own requests (AdjustmentsService.list scopes it server-side by the caller's
// id), plus Withdraw on their own pending rows — the first screen visible to both
// roles with a different action set (the Products screen already establishes that
// pattern at the button level, Phase 5).
//
// "Delta as of now" is recomputed by the server on every list load and never a value
// frozen at request time (§1) — approving still recomputes it a final time under lock.
export function approvals(container, query){
  let status = (query && query.get('status')) || 'pending';
  let productId = (query && query.get('productId')) || '';
  let days = '';
  let override = 'normal';
  // { id, kind: 'reject'|'withdraw' } — the row currently showing an inline reason
  // prompt. Mandatory reason (§1), so there is a prompt rather than a bare button.
  let promptFor = null;

  const owner = isOwner();
  const currentUser = getCurrentUser();
  const myId = currentUser ? currentUser.id : null;

  const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };

  function ageText(d){
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function load(){
    container.innerHTML = header() + toolbar() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(9,6)}</tbody></table></div>`;
    attachHeaderHandlers();
    UI.mockFetch(async () => {
      if (override === 'empty') return { items: [], truncated: false };
      return Store.listAdjustmentRequests({
        status: status || undefined,
        productId: productId || undefined,
        days: days ? Number(days) : undefined,
      });
    }, { forceState: override === 'error' ? 'error' : null })
      .then(result => { container.innerHTML = header() + toolbar() + body(result.items, result.truncated); attachAll(); })
      .catch(err => { container.innerHTML = header() + toolbar() + UI.errorState(err.message, 'retry'); attachAll(); });
  }

  function header(){
    return `<div class="content-header"><div><h1>Approvals</h1><div class="sub">${owner
      ? 'Stocktake corrections submitted by staff. Approving one records the adjustment; rejecting one does not.'
      : 'Adjustments you submitted. Stock changes only once an Owner approves the count.'}</div></div></div>`;
  }

  function toolbar(){
    return `<div class="toolbar">
      <select class="select-filter" id="ap-status">
        ${Object.entries(STATUS_LABEL).map(([v,l]) => `<option value="${v}" ${status===v?'selected':''}>${l}</option>`).join('')}
        <option value="" ${status===''?'selected':''}>All</option>
      </select>
      <select class="select-filter" id="ap-days">
        <option value="">All time</option>
        <option value="7" ${days==='7'?'selected':''}>Last 7 days</option>
        <option value="30" ${days==='30'?'selected':''}>Last 30 days</option>
        <option value="90" ${days==='90'?'selected':''}>Last 90 days</option>
      </select>
      ${productId ? `<button type="button" class="btn btn-ghost btn-sm" id="ap-clear-product">Filtered to one product &times;</button>` : ''}
      ${UI.previewControl(override)}
    </div>`;
  }

  function body(list, truncated){
    if (list.length === 0){
      return UI.emptyState(
        override === 'empty' ? 'Nothing to approve' : 'No matching requests',
        override === 'empty'
          ? 'When a staff member records an adjustment, it appears here for review.'
          : 'Try a different status or time range.',
      );
    }
    const notice = truncated
      ? UI.truncationNotice(list.length, 'requests', 'Filter by status, product, or time range to see more.')
      : '';
    return notice + `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Submitted</th><th>Product</th><th>Counted</th><th>Requester saw</th><th>Now</th><th>Change if approved</th><th>Requester</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody>
    </table></div>`;
  }

  function rowHtml(r){
    const unit = r.product ? r.product.unit : '';
    const deltaCell = r.status === 'pending' && r.delta !== null
      ? `<span class="tnum ${r.delta > 0 ? 'qty-pos' : (r.delta < 0 ? 'qty-neg' : '')}">${UI.fmtQty(r.delta, unit)}</span>`
      : '<span class="cell-sub">—</span>';
    const nowCell = r.status === 'pending' && r.currentStock !== null
      ? `<span class="tnum">${r.currentStock} ${UI.esc(unit)}</span>`
      : '<span class="cell-sub">—</span>';
    const statusCell = r.status === 'pending'
      ? '<span class="badge badge-low">Pending</span>'
      : `<span class="badge ${r.status === 'approved' ? 'badge-active' : 'badge-inactive'}">${STATUS_LABEL[r.status]}</span>`
        + (r.resolvedBy ? `<div class="cell-sub">by ${UI.esc(r.resolvedBy.name)}</div>` : '')
        + (r.resolutionReason ? `<div class="cell-sub">“${UI.esc(r.resolutionReason)}”</div>` : '');

    let actionCell = '';
    if (r.status === 'pending'){
      if (promptFor && promptFor.id === r.id){
        const verb = promptFor.kind === 'reject' ? 'Reject' : 'Withdraw';
        actionCell = `<div class="confirm-inline">
          <input type="text" class="ap-reason-input" data-id="${r.id}" placeholder="Reason (required)" style="min-width:160px">
          <button class="btn btn-primary btn-sm ap-reason-confirm" data-id="${r.id}" data-kind="${promptFor.kind}">${verb}</button>
          <button class="btn btn-ghost btn-sm ap-reason-cancel">Cancel</button>
        </div>`;
      } else if (owner){
        actionCell = `<div class="row-actions">
          <button class="btn btn-primary btn-sm ap-approve" data-id="${r.id}">Approve</button>
          <button class="btn btn-secondary btn-sm ap-reject" data-id="${r.id}">Reject</button>
        </div>`;
      } else if (myId && r.requestedBy && r.requestedBy.id === myId){
        actionCell = `<button class="btn btn-secondary btn-sm ap-withdraw" data-id="${r.id}">Withdraw</button>`;
      }
    } else if (r.status === 'approved' && r.resultingTransactionId){
      // The product detail page carries a transaction-history panel; the just-approved
      // adjustment is at the top of it. (#/history has no productId query filter.)
      actionCell = `<a class="btn btn-ghost btn-sm" href="#/products/${r.productId}">View movement</a>`;
    }

    return `<tr>
      <td class="cell-sub">${ageText(r.createdAt)}<div class="cell-sub">${UI.fmtDate(r.createdAt)}</div></td>
      <td>${r.product ? `<a href="#/products/${r.productId}">${UI.esc(r.product.name)}</a>` : `#${r.productId}`}</td>
      <td class="tnum">${r.newQuantity} ${UI.esc(unit)}</td>
      <td class="cell-sub tnum">${r.stockAtRequest} ${UI.esc(unit)}</td>
      <td>${nowCell}</td>
      <td>${deltaCell}</td>
      <td class="cell-sub">${r.requestedBy ? UI.esc(r.requestedBy.name) : '—'}</td>
      <td>${statusCell}</td>
      <td>${actionCell}</td>
    </tr>`;
  }

  function resolve(id, body){
    Store.resolveAdjustmentRequest(id, body)
      .then(() => {
        promptFor = null;
        UI.toast(
          body.status === 'approved' ? 'Adjustment approved — stock updated.'
          : body.status === 'rejected' ? 'Request rejected.'
          : 'Request withdrawn.',
          'success',
        );
        updateApprovalsBadge();
        load();
      })
      .catch(err => { UI.toast(err.message, 'error'); promptFor = null; load(); });
  }

  function attachHeaderHandlers(){
    const s = container.querySelector('#ap-status'); if (s) s.addEventListener('change', e => { status = e.target.value; promptFor = null; load(); });
    const d = container.querySelector('#ap-days'); if (d) d.addEventListener('change', e => { days = e.target.value; load(); });
    const cp = container.querySelector('#ap-clear-product'); if (cp) cp.addEventListener('click', () => { productId = ''; load(); });
    const pr = container.querySelector('#preview-select'); if (pr) pr.addEventListener('change', e => { override = e.target.value; load(); });
  }

  function attachAll(){
    attachHeaderHandlers();
    const retry = container.querySelector('#retry'); if (retry) retry.addEventListener('click', () => { override = 'normal'; load(); });
    container.querySelectorAll('.ap-approve').forEach(b => b.addEventListener('click', () => resolve(Number(b.dataset.id), { status: 'approved' })));
    container.querySelectorAll('.ap-reject').forEach(b => b.addEventListener('click', () => { promptFor = { id: Number(b.dataset.id), kind: 'reject' }; load(); }));
    container.querySelectorAll('.ap-withdraw').forEach(b => b.addEventListener('click', () => { promptFor = { id: Number(b.dataset.id), kind: 'withdraw' }; load(); }));
    container.querySelectorAll('.ap-reason-cancel').forEach(b => b.addEventListener('click', () => { promptFor = null; load(); }));
    container.querySelectorAll('.ap-reason-confirm').forEach(b => b.addEventListener('click', () => {
      const input = container.querySelector(`.ap-reason-input[data-id="${b.dataset.id}"]`);
      const reason = input ? input.value.trim() : '';
      if (!reason){ if (input){ input.classList.add('has-error'); input.focus(); } return; }
      resolve(Number(b.dataset.id), { status: b.dataset.kind === 'reject' ? 'rejected' : 'withdrawn', reason });
    }));
    const firstInput = container.querySelector('.ap-reason-input'); if (firstInput) firstInput.focus();
  }

  load();
}
