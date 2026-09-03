import { UI } from '../ui.js';
import { Store } from '../api.js';

// Phase 9 (docs/phase-9-plan.md §1's closed list, §3): a human label per
// AuditEventType, for the Event column and the toolbar's type filter. Kept as a flat
// map rather than derived from the enum string so the wording can read naturally
// ("Locked out" reads better than "Account locked") without touching the wire value.
const AUDIT_EVENT_LABEL = {
  login_succeeded: 'Login succeeded',
  login_failed: 'Login failed',
  account_locked: 'Locked out',
  password_changed: 'Password changed',
  user_created: 'User created',
  user_updated: 'User updated',
  user_status_changed: 'User status changed',
  user_password_reset: 'Password reset',
  product_created: 'Product created',
  product_updated: 'Product updated',
  product_status_changed: 'Product status changed',
  product_deleted: 'Product deleted',
  supplier_created: 'Supplier created',
  supplier_updated: 'Supplier updated',
  supplier_status_changed: 'Supplier status changed',
  category_created: 'Category created',
  category_updated: 'Category updated',
  category_deleted: 'Category deleted',
};

// -------------------------------------------------------------- Audit Log --
// FR-065 (docs/phase-9-plan.md §3). Same structure as Views.historyView — a
// filtered, read-only, newest-first table with a toolbar of <select>s — since that's
// the closest existing analogue: a log, not a managed resource. Owner-only,
// server-enforced (AuditController's class-level @Roles) and client-gated the same
// way as #/users (isOwnerOnlyRoute in renderApp()).
//
// No per-event detail drawer, no drilldown into subject/target: the `summary` IS the
// detail (§1 — a human sentence was chosen over a diff precisely so there's nothing
// further to open), so every column here renders plain text.
export function auditLog(container, query){
  let eventType = (query && query.get('eventType')) || '';
  // Reads the incoming ?subjectUserId= straight off the URL — this is the landing
  // state for the one cross-link the whole phase is built around: each row of
  // Views.userList (most visibly the `locked` badge) links to #/audit?subjectUserId=.
  let subjectUserId = (query && query.get('subjectUserId')) || '';
  let days = '';
  let override = 'normal';

  function load(){
    container.innerHTML = header() + toolbar() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(6,6)}</tbody></table></div>`;
    attachHeaderHandlers();
    UI.mockFetch(async () => {
      if (override === 'empty') return { items: [], truncated: false };
      return Store.listAuditEvents({
        eventType: eventType || undefined,
        subjectUserId: subjectUserId || undefined,
        days: days ? Number(days) : undefined,
      });
    }, { forceState: override === 'error' ? 'error' : null })
      .then(result => { container.innerHTML = header() + toolbar() + body(result.items, result.truncated); attachAll(); })
      .catch(err => { container.innerHTML = header() + toolbar() + UI.errorState(err.message, 'retry'); attachAll(); });
  }

  function header(){
    return `<div class="content-header"><div><h1>Audit Log</h1><div class="sub">Who did what, and when — account changes, catalog edits, and every login attempt.</div></div></div>`;
  }

  function toolbar(){
    return `<div class="toolbar">
      <select class="select-filter" id="a-type">
        <option value="">All events</option>
        ${Object.entries(AUDIT_EVENT_LABEL).map(([value, label]) => `<option value="${value}" ${eventType===value?'selected':''}>${UI.esc(label)}</option>`).join('')}
      </select>
      <select class="select-filter" id="a-days">
        <option value="">All time</option>
        <option value="7" ${days==='7'?'selected':''}>Last 7 days</option>
        <option value="30" ${days==='30'?'selected':''}>Last 30 days</option>
        <option value="90" ${days==='90'?'selected':''}>Last 90 days</option>
      </select>
      ${subjectUserId ? `<button type="button" class="btn btn-ghost btn-sm" id="a-clear-subject">Filtered to one account &times;</button>` : ''}
      ${UI.previewControl(override)}
    </div>`;
  }

  function body(list, truncated){
    if (list.length === 0){
      return UI.emptyState(
        override === 'empty' ? 'No audit events recorded' : 'No matching events',
        override === 'empty' ? 'Events will appear here once someone logs in or an Owner makes a change.' : 'Try a different filter combination.',
      );
    }
    // Phase 11: "narrow the range" here means the filters this toolbar already has —
    // event type, account, and the 7/30/90-day selector — which is exactly the
    // interaction model Phase 9 chose when it capped this route and declined offset
    // pagination (docs/phase-9-plan.md §1).
    const notice = truncated
      ? UI.truncationNotice(list.length, 'events', 'Filter by event type, account, or time range to see more.')
      : '';
    return notice + `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Subject / Target</th><th>Details</th><th>Address</th></tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody>
    </table></div>`;
  }

  // Address (docs/phase-9-plan.md §1 fork A) is evidence to read, not an index to
  // pivot on — §3 explicitly rules out a filter for it, but the whole argument for
  // capturing it was that an Owner needs to SEE it to tell "Riley fumbling at the
  // counter" from "a script working through an email list." Blank on every
  // administrative row (actorIp is only ever set on authentication events) — that
  // blankness is itself truthful, not a missing column.
  function rowHtml(e){
    const target = e.subject
      ? UI.esc(e.subject.name)
      : (e.entityType ? `<span class="cell-sub">${UI.esc(e.entityType)} #${e.entityId}</span>` : '<span class="cell-sub">—</span>');
    return `<tr>
      <td class="cell-sub">${UI.fmtDateTime(e.date)}</td>
      <td>${UI.esc(AUDIT_EVENT_LABEL[e.eventType] || e.eventType)}</td>
      <td class="cell-sub">${e.actor ? UI.esc(e.actor.name) : '—'}</td>
      <td>${target}</td>
      <td>${UI.esc(e.summary)}</td>
      <td class="cell-sub">${e.actorIp ? UI.esc(e.actorIp) : '—'}</td>
    </tr>`;
  }

  function attachHeaderHandlers(){
    const t = container.querySelector('#a-type'); if (t) t.addEventListener('change', e => { eventType = e.target.value; load(); });
    const d = container.querySelector('#a-days'); if (d) d.addEventListener('change', e => { days = e.target.value; load(); });
    const clear = container.querySelector('#a-clear-subject'); if (clear) clear.addEventListener('click', () => { subjectUserId = ''; load(); });
    const pr = container.querySelector('#preview-select'); if (pr) pr.addEventListener('change', e => { override = e.target.value; load(); });
  }
  function attachAll(){
    attachHeaderHandlers();
    const retry = container.querySelector('#retry'); if (retry) retry.addEventListener('click', () => { override = 'normal'; load(); });
  }

  load();
}
