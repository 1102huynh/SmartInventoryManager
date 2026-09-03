// The Store client — a thin wrapper around fetch() calls to the NestJS API. Every
// method returns a Promise, and the business rules Phase 1's Store enforced
// client-side (BR-020/021, BR-031/033, BR-060/061, BR-001...) now live exactly once,
// server-side, in InventoryService/ProductsService (see backend/src). This file
// trusts the API's responses instead of re-deriving them.
//
// Imports config.js (API_BASE + the normalizers), session.js (the token and current
// user), reference-data.js (the category cache), ui.js (navigate on 401), and
// router.js (renderApp, for the one case where the hash is already '#/login' and
// setting it again would fire no event). The api.js ↔ router.js import cycle is
// runtime-only — neither module calls the other at evaluation time — which ES
// modules handle without issue.

import { API_BASE, normalizeTx, normalizeAuditEvent, normalizeAdjustmentRequest } from './config.js';
import { getAccessToken, setAccessToken, getCurrentUser, setCurrentUser, clearSession } from './session.js';
import { setCategories } from './reference-data.js';
import { UI } from './ui.js';
import { renderApp } from './router.js';

// Phase 1's mockup scaffolding that survived into the real app: mockFetch (in ui.js)
// and the `?state=error`/`empty` overrides let a developer force a screen's
// error/empty state without breaking the backend. Phase 13 moved them and changed
// nothing about them — not deleted (a behaviour change, deferred with its own
// trigger in docs/phase-13-plan.md §7), not promoted.

export const Store = {
  // Every request goes through here: it attaches the bearer token (see
  // docs/phase-3-plan.md "Token transport" — this replaces Phase 2's client-supplied
  // `x-user-id` header with a server-verified token), and turns a non-2xx response
  // into a thrown Error whose message is exactly what the API's
  // ValidationPipe/exception filter sent back — the same message a
  // `try { await Store.x() } catch (err) { err.message }` pattern in the wizards
  // already expected from Phase 1's synchronous version.
  // `opts.withTruncation` (Phase 11, docs/phase-11-plan.md §3): the two bounded
  // transaction-list reads need one response header — `X-Result-Truncated` — that the
  // parsed JSON body no longer carries. Rather than a general response-metadata layer,
  // this one flag: with it set, `_request` resolves to `{ data, truncated }` instead
  // of bare `data`. Every other caller is untouched.
  async _request(method, path, body, opts){
    const options = { method, headers: {} };
    if (body !== undefined){
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const token = getAccessToken();
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(API_BASE + path, options);
    const wrap = (data) => {
      // Phase 11: `withTruncation` surfaces the X-Result-Truncated header alongside
      // the body. Phase 12: `withStatus` surfaces the HTTP status code — POST
      // /products/:id/adjustments returns 201 (Owner, recorded) or 202 (Staff, queued
      // for approval) with two different body shapes, and the wizard has to tell them
      // apart. Every other caller is untouched.
      if (opts && opts.withTruncation)
        return { data, truncated: res.headers.get('X-Result-Truncated') === 'true' };
      if (opts && opts.withStatus) return { data, status: res.status };
      return data;
    };
    if (res.status === 204) return wrap(null);
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    // A 401 here means the token we were holding (if any) is no longer good enough —
    // missing, expired, or malformed. Discard it and bounce back to the login screen.
    // Excluded for /auth/login itself: a *wrong password* also comes back as 401, and
    // that's a form validation error the login screen should display inline, not a
    // "your session expired" redirect (see Views.login).
    let sessionIsDead = res.status === 401 && path !== '/auth/login';
    // PATCH /auth/password is genuinely ambiguous, not simply excluded like login:
    // UsersService.changeOwnPassword ALSO returns 401 for a wrong *current* password
    // even though the caller's token is perfectly valid — the deliberate status code
    // docs/phase-6-plan.md §1 calls for ("the failure is 'you have not proven you are
    // this user'"), not a bug to route around. So a 401 here could mean either "this
    // token is dead" or "that password was wrong," and those need opposite UI
    // responses. Resolve it by asking the token itself, on GET /auth/me: still 401
    // there too means the token really is dead, so fall through to the logout below;
    // anything else (200, or the probe failing to even reach the server) means the
    // token's fine and this was just a wrong password — leave it as a normal error for
    // Views.account to show inline, the same as any other form validation failure.
    if (sessionIsDead && path === '/auth/password'){
      const probe = await fetch(API_BASE + '/auth/me', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => null);
      sessionIsDead = !!probe && probe.status === 401;
    }
    if (sessionIsDead){
      clearSession();
      if (location.hash !== '#/login') UI.navigate('#/login'); else renderApp();
    }
    // A 403 (RolesGuard, Phase 5) is deliberately NOT handled here the way 401 is —
    // the session is fine, the signed-in user just isn't allowed to do this one
    // thing. It falls through to the generic throw below, which the forms/wizards
    // already surface as an inline/toast error. Do not fold this into the 401
    // branch above: that would log a Staff user out for clicking something they
    // merely can't do.
    //
    // A 429 (rate limiting, Phase 8, docs/phase-8-plan.md §3) needs exactly the same
    // protection, for exactly the same reason — the session is fine, the server is
    // just saying "slow down." It also falls through to the generic throw below,
    // whose message is the server's own ("Too many requests…"), including on
    // POST /auth/login, where it renders inline on the login form the same way a
    // wrong password does (a locked-account 401 already works this way — see
    // Views.login). Do not fold this into the 401 branch either.
    if (!res.ok){
      const message = data && (Array.isArray(data.message) ? data.message.join(' ') : data.message);
      throw new Error(message || `Request failed (${res.status}).`);
    }
    return wrap(data);
  },

  // FR-060. Every write endpoint requires a token now (JwtAuthGuard, registered
  // globally — see docs/phase-3-plan.md "Guard rollout"), so nothing else in Store
  // can succeed until this has run. Loads reference data (categories) as part of
  // login rather than leaving the caller to remember a second step — every view that
  // reads the category cache synchronously needs it populated by the time the
  // post-login route first renders.
  async login(email, password){
    const result = await this._request('POST', '/auth/login', { email, password });
    setAccessToken(result.accessToken);
    setCurrentUser(result.user);
    await this.loadReferenceData();
    return result.user;
  },

  // Client-side only, no server call — a stateless JWT can't be revoked without
  // adding the exact kind of server-side state a JWT is meant to avoid (see
  // docs/phase-3-plan.md "Logout: client-side only, no revocation list"). Signing
  // out just means the frontend forgets the token.
  logout(){
    clearSession();
    if (location.hash === '#/login') renderApp(); else UI.navigate('#/login');
  },

  async loadReferenceData(){
    setCategories(await this._request('GET', '/categories'));
  },

  // FR-005/phase-4-plan.md §3. Each mutation re-populates the category cache from the
  // server afterward (the same refresh-after-write pattern used elsewhere in Store)
  // rather than hand-patching the in-memory array, so every screen reading it
  // synchronously (product list/form, the category screen) stays correct without its
  // own re-fetch.
  createCategory(data){
    return this._request('POST', '/categories', { name: data.name.trim() })
      .then(result => this.loadReferenceData().then(() => result));
  },
  updateCategory(id, data){
    return this._request('PATCH', `/categories/${id}`, { name: data.name.trim() })
      .then(result => this.loadReferenceData().then(() => result));
  },
  deleteCategory(id){
    return this._request('DELETE', `/categories/${id}`)
      .then(() => this.loadReferenceData());
  },

  listProducts({ search, status, category } = {}){
    const q = new URLSearchParams();
    if (search) q.set('search', search);
    if (status) q.set('status', status);
    if (category) q.set('categoryId', category);
    const qs = q.toString();
    return this._request('GET', '/products' + (qs ? '?' + qs : ''));
  },
  getProduct(id){ return this._request('GET', `/products/${id}`); },
  createProduct(data){
    return this._request('POST', '/products', {
      name: data.name.trim(),
      sku: data.sku.trim(),
      unit: data.unit.trim(),
      categoryId: data.categoryId ? Number(data.categoryId) : undefined,
      lowStockThreshold: data.threshold === '' ? undefined : Number(data.threshold),
    });
  },
  updateProduct(id, data){
    const body = {
      name: data.name.trim(),
      unit: data.unit.trim(),
      categoryId: data.categoryId ? Number(data.categoryId) : null,
      lowStockThreshold: data.threshold === '' ? null : Number(data.threshold),
    };
    // Omitted entirely when locked, rather than sent unchanged — matches the Product
    // Form disabling the field outright when the product has history (BR-001).
    if (data.sku !== undefined) body.sku = data.sku.trim();
    return this._request('PATCH', `/products/${id}`, body);
  },
  setProductStatus(id, status){ return this._request('PATCH', `/products/${id}/status`, { status }); },
  deleteProduct(id){ return this._request('DELETE', `/products/${id}`); },

  listSuppliers({ status, search } = {}){
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (search) q.set('search', search);
    const qs = q.toString();
    return this._request('GET', '/suppliers' + (qs ? '?' + qs : ''));
  },
  getSupplierById(id){ return this._request('GET', `/suppliers/${id}`); },
  createSupplier(data){
    return this._request('POST', '/suppliers', {
      name: data.name.trim(),
      contactName: (data.contact || '').trim() || undefined,
      email: (data.email || '').trim() || undefined,
      phone: (data.phone || '').trim() || undefined,
    });
  },
  updateSupplier(id, data){
    return this._request('PATCH', `/suppliers/${id}`, {
      name: data.name.trim(),
      contactName: (data.contact || '').trim(),
      email: (data.email || '').trim(),
      phone: (data.phone || '').trim(),
    });
  },
  setSupplierStatus(id, status){ return this._request('PATCH', `/suppliers/${id}/status`, { status }); },

  // Phase 6 (docs/phase-6-plan.md §2/§3): Owner-only user management — the server
  // (UsersController's class-level @Roles(UserRole.Owner)) is the actual enforcement
  // point, same as every other role gate in this app; the frontend only avoids
  // offering actions that would 403.
  getUsers(){ return this._request('GET', '/users'); },
  getUserById(id){ return this._request('GET', `/users/${id}`); },
  createUser(data){
    return this._request('POST', '/users', {
      name: data.name.trim(),
      email: data.email.trim(),
      role: data.role,
      password: data.password,
    });
  },
  updateUser(id, data){
    return this._request('PATCH', `/users/${id}`, {
      name: data.name.trim(),
      email: data.email.trim(),
      role: data.role,
    }).then(result => this._refreshCurrentUserIfSelf(id).then(() => result));
  },
  setUserStatus(id, status){
    return this._request('PATCH', `/users/${id}/status`, { status })
      .then(result => this._refreshCurrentUserIfSelf(id).then(() => result));
  },
  // A reset, not a recovery (docs/phase-6-plan.md §1) — no current password involved;
  // the Owner is acting on someone else's account. Returns no body (204).
  resetUserPassword(id, newPassword){
    return this._request('PATCH', `/users/${id}/password`, { newPassword });
  },
  // Self-service — any authenticated user, their own account, current password
  // required. Lives on /auth (AuthController), not /users — see api.md.
  changeOwnPassword(currentPassword, newPassword){
    return this._request('PATCH', '/auth/password', { currentPassword, newPassword });
  },

  // Phase 6 (docs/phase-6-plan.md §3 "CURRENT_USER must be refreshed after a write to
  // one's own record"): one small helper so every caller that writes to a user record
  // doesn't have to separately remember whether that record happens to be the
  // signed-in Owner's own. If it is, GET /auth/me is re-fetched and the current user
  // reassigned so isOwner() and the user chip never show a stale role/name — the
  // server is already enforcing the new one.
  //
  // The one edge case this deliberately does NOT special-case: an Owner deactivating
  // themselves. The write that got us here (PATCH /users/:id or .../status) already
  // succeeded — this refresh is a best-effort cache update layered on top of that, not
  // part of the operation. When the deactivated account is the caller's own, the
  // re-fetch below gets a 401 from JwtStrategy.validate, and Store._request's existing
  // 401 handling logs them out — the correct outcome for someone who just switched off
  // their own only active session. But `_request` also THROWS after handling that
  // 401, and letting that rejection escape here would fail the caller's own `.then()`
  // chain (e.g. Views.userList's), turning a successful deactivation into what reads
  // as a crash: a red "Unauthorized" error toast on top of a screen that just
  // navigated to #/login. The logout side effect above already ran by the time this
  // rejects, so there's nothing left worth propagating — swallow it.
  _refreshCurrentUserIfSelf(id){
    const current = getCurrentUser();
    if (!current || Number(id) !== current.id) return Promise.resolve();
    return this._request('GET', '/auth/me').then(me => { setCurrentUser(me); }).catch(() => {});
  },

  // Phase 11 (docs/phase-11-plan.md §3): every bounded list read returns
  // `{ items, truncated }` — `truncated` drives the "showing the most recent N" line
  // on the screen that renders it.
  //
  // `listTransactionsForSupplier` is included, and its first version was not. It reads
  // the SAME capped route as listAllTransactions (`/inventory-transactions`, filtered
  // by supplierId — api.md names that panel as a consumer of it), so it was already
  // being truncated at 100 with nothing said; before this phase that panel showed
  // every stock-in from a supplier. A screen that quietly stops mid-record is the
  // defect the phase exists to remove, and "only two screens ask for the header" was a
  // property of the first implementation, not a decision about this one.
  async listTransactionsForProduct(id){
    const { data, truncated } = await this._request('GET', `/products/${id}/transactions`, undefined, { withTruncation: true });
    return { items: data.map(normalizeTx), truncated };
  },
  async listTransactionsForSupplier(id){
    const { data, truncated } = await this._request('GET', `/inventory-transactions?supplierId=${id}`, undefined, { withTruncation: true });
    return { items: data.map(normalizeTx), truncated };
  },
  async listAllTransactions({ type, productId, days } = {}){
    const q = new URLSearchParams();
    if (type) q.set('type', type === 'stock-in' ? 'stock_in' : type === 'stock-out' ? 'stock_out' : type);
    if (productId) q.set('productId', productId);
    if (days) q.set('days', days);
    const qs = q.toString();
    const { data, truncated } = await this._request('GET', '/inventory-transactions' + (qs ? '?' + qs : ''), undefined, { withTruncation: true });
    return { items: data.map(normalizeTx), truncated };
  },

  // Phase 9 (docs/phase-9-plan.md §3): built exactly like listAllTransactions — query
  // string assembly, one GET, one normalize pass. Owner-only server-side
  // (AuditController's class-level @Roles) — this method has no opinion about that,
  // the same way Store.getUsers doesn't gate itself either.
  //
  // Phase 11: returns `{ items, truncated }` like the transaction reads. This route has
  // been capped at 100 since Phase 9 and said nothing about it; the header exists now,
  // and the Audit Log screen reads it. The consequence of staying silent is sharper
  // here than anywhere else in the app: an Owner scrolling to the bottom of this
  // screen to answer "has anything else happened to this account" would read the end
  // of one page as the end of the record.
  async listAuditEvents({ eventType, actorUserId, subjectUserId, days, limit } = {}){
    const q = new URLSearchParams();
    if (eventType) q.set('eventType', eventType);
    if (actorUserId) q.set('actorUserId', actorUserId);
    if (subjectUserId) q.set('subjectUserId', subjectUserId);
    if (days) q.set('days', days);
    if (limit) q.set('limit', limit);
    const qs = q.toString();
    const { data, truncated } = await this._request('GET', '/audit-events' + (qs ? '?' + qs : ''), undefined, { withTruncation: true });
    return { items: data.map(normalizeAuditEvent), truncated };
  },

  getDashboardSummary(){ return this._request('GET', '/dashboard/summary'); },

  // Three thin methods instead of Phase 1's single createTransaction({ type, ... })
  // dispatcher — each now maps to its own REST action (POST /products/:id/stock-in
  // etc.), so there's no client-side type-switch left to keep in sync with the API.
  async recordStockIn(productId, { quantity, date, supplierId }){
    const tx = await this._request('POST', `/products/${productId}/stock-in`, {
      quantity: Number(quantity), occurredAt: date, supplierId: supplierId ? Number(supplierId) : undefined,
    });
    return normalizeTx(tx);
  },
  async recordStockOut(productId, { quantity, date, reason }){
    const tx = await this._request('POST', `/products/${productId}/stock-out`, {
      quantity: Number(quantity), occurredAt: date, reason: reason || undefined,
    });
    return normalizeTx(tx);
  },
  // Phase 12 (docs/phase-12-plan.md §3): one route, two outcomes. An Owner's
  // adjustment is recorded immediately (201, an InventoryTransaction); a Staff
  // member's becomes a pending request (202, an AdjustmentRequest). The caller (the
  // wizard's success step) branches on the discriminated result.
  async recordAdjustment(productId, { newQty, date, reason }){
    const { data, status } = await this._request(
      'POST', `/products/${productId}/adjustments`,
      { newQuantity: Number(newQty), occurredAt: date, reason },
      { withStatus: true },
    );
    return status === 202
      ? { outcome: 'requested', request: normalizeAdjustmentRequest(data) }
      : { outcome: 'recorded', transaction: normalizeTx(data) };
  },

  // Phase 12 (docs/phase-12-plan.md §3). Built like listAuditEvents — query-string
  // assembly, one GET, one normalize pass — and returns { items, truncated } in the
  // shape the four existing bounded reads already return (the fifth caller of the
  // Phase 11 pattern). Server-side the read is open to both roles (BR-073); this
  // method has no opinion about that.
  async listAdjustmentRequests({ status, productId, days, limit } = {}){
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (productId) q.set('productId', productId);
    if (days) q.set('days', days);
    if (limit) q.set('limit', limit);
    const qs = q.toString();
    const { data, truncated } = await this._request(
      'GET', '/adjustment-requests' + (qs ? '?' + qs : ''),
      undefined, { withTruncation: true },
    );
    return { items: data.map(normalizeAdjustmentRequest), truncated };
  },

  // PATCH /adjustment-requests/:id/status — the fourth status PATCH in the app. The
  // service enforces who may do what (approve/reject → Owner, withdraw → the
  // requester), so this method just forwards. Approve carries the created transaction
  // back on `resultingTransactionId`.
  async resolveAdjustmentRequest(id, { status, reason }){
    const r = await this._request('PATCH', `/adjustment-requests/${id}/status`, {
      status, reason: reason || undefined,
    });
    return normalizeAdjustmentRequest(r);
  },

  // The nav badge (§3 item 4). Deliberately not a dashboard tile — that would mean
  // changing GET /dashboard/summary, which BR-062 keeps composed from FR-004/031/042
  // and nothing else. Chrome, not dashboard data: one small bounded read.
  async countPendingAdjustments(){
    const { items, truncated } = await this.listAdjustmentRequests({ status: 'pending', limit: 100 });
    return { count: items.length, more: truncated };
  },
};
