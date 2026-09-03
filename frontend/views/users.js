import { ROLE_LABEL } from '../config.js';
import { getCurrentUser } from '../session.js';
import { UI } from '../ui.js';
import { Store } from '../api.js';

// -------------------------------------------------------------- User List --
// FR-063 (docs/phase-6-plan.md §3). Owner-only, enforced server-side
// (UsersController's class-level @Roles) and mirrored client-side by
// isOwnerOnlyRoute in renderApp(). No separate detail page — deactivate/reactivate
// happens inline, right on this list, the same confirm-then-confirm pattern
// Views.supplierDetail uses for its own toggle.
export function userList(container, query){
  let users = [];
  let confirmToggleId = null;

  function load(){
    container.innerHTML = header() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(4,4)}</tbody></table></div>`;
    Store.getUsers().then(list => { users = list; render(); })
      .catch(err => { container.innerHTML = header() + UI.errorState(err.message, 'retry'); attachHeaderOnly(); });
  }

  function header(){
    return `<div class="content-header">
      <div><h1>Users</h1><div class="sub">Everyone with a login to Smart Inventory Manager.</div></div>
      <div class="header-actions"><a class="btn btn-primary" href="#/users/new">${UI.icon('plus')} New User</a></div>
    </div>`;
  }

  function body(){
    if (users.length === 0) return UI.emptyState('No users yet', 'Create the first account to get started.');
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map(rowHtml).join('')}</tbody>
    </table></div>`;
  }

  function rowHtml(u){
    // The signed-in Owner's own row is marked "you" — the deactivate control on that
    // one row is the one with a consequence they should see coming (docs/phase-6-plan.md §3).
    const current = getCurrentUser();
    const isSelf = !!current && u.id === current.id;
    const toggleLabel = u.status === 'active' ? 'Deactivate' : 'Reactivate';
    const actions = confirmToggleId === u.id
      ? `<div class="confirm-inline">${toggleLabel} ${UI.esc(u.name)}?
          <button class="btn btn-ghost btn-sm" data-cancel-toggle="${u.id}">Cancel</button>
          <button class="btn btn-danger btn-sm" data-do-toggle="${u.id}">Confirm</button>
        </div>`
      // History: the cross-link the whole phase is built around (docs/phase-9-plan.md
      // §3) — every row gets one, not just locked ones; the locked badge above is
      // just the most visible entry point into the same screen. No isOwner()
      // check needed here — this whole view is already Owner-gated (see the class
      // comment above).
      : `<div class="action-row">
          <a class="btn btn-ghost btn-sm" href="#/users/${u.id}/edit">Edit</a>
          <button class="btn btn-ghost btn-sm" data-start-toggle="${u.id}">${toggleLabel}</button>
          <a class="btn btn-ghost btn-sm" href="#/audit?subjectUserId=${u.id}">History</a>
        </div>`;
    return `<tr>
      <td class="cell-name">${UI.esc(u.name)} ${isSelf ? '<span class="badge badge-inactive">You</span>' : ''}</td>
      <td class="cell-sub">${UI.esc(u.email)}</td>
      <td>${UI.esc(ROLE_LABEL[u.role] || u.role)}</td>
      <td>${UI.badgeStatus(u.status)} ${u.locked ? `<a href="#/audit?subjectUserId=${u.id}">${UI.badgeLocked(u.locked)}</a>` : ''}</td>
      <td>${actions}</td>
    </tr>`;
  }

  function render(){
    container.innerHTML = header() + body();
    attach();
  }

  function attachHeaderOnly(){
    const retry = container.querySelector('#retry');
    if (retry) retry.addEventListener('click', load);
  }

  function attach(){
    container.querySelectorAll('[data-start-toggle]').forEach(btn => btn.addEventListener('click', () => {
      confirmToggleId = Number(btn.dataset.startToggle); render();
    }));
    container.querySelectorAll('[data-cancel-toggle]').forEach(btn => btn.addEventListener('click', () => {
      confirmToggleId = null; render();
    }));
    container.querySelectorAll('[data-do-toggle]').forEach(btn => btn.addEventListener('click', () => {
      const id = Number(btn.dataset.doToggle);
      const u = users.find(x => x.id === id);
      const next = u.status === 'active' ? 'inactive' : 'active';
      Store.setUserStatus(id, next)
        .then(() => {
          UI.toast(`${u.name} ${next === 'active' ? 'reactivated' : 'deactivated'}.`, 'success');
          confirmToggleId = null;
          return load();
        })
        .catch(err => { UI.toast(err.message, 'error'); confirmToggleId = null; render(); });
    }));
    attachHeaderOnly();
  }

  load();
}

// -------------------------------------------------------------- User Form --
// FR-063. Create and edit, the same one-view-two-modes pattern as
// Views.productForm/Views.supplierForm. The password field appears only in create
// mode (docs/phase-6-plan.md §1 "The Owner types the initial password" /
// "editing a user never shows or asks for a password") — resetting an existing
// user's password is a separate action (below), deliberately not part of this form.
export function userForm(container, id){
  const editing = !!id;
  let user = null;
  const state = { name: '', email: '', role: 'staff', password: '' };
  let errors = {};
  let pw = { newPassword: '', confirm: '' };
  let pwErrors = {};
  let pwSubmitting = false;

  function load(){
    if (!editing){ render(); return; }
    container.innerHTML = `<div class="skeleton skeleton-line" style="width:220px;height:24px"></div>`;
    Store.getUserById(id).then(u => {
      user = u;
      state.name = u.name; state.email = u.email; state.role = u.role;
      render();
    }).catch(err => { container.innerHTML = UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function render(){
    container.innerHTML = `
      <div class="topbar-crumbs" style="margin-bottom:10px"><a href="#/users">Users</a> / ${editing ? UI.esc(user.name) : 'New User'}</div>
      <div class="content-header"><div><h1>${editing ? 'Edit User' : 'New User'}</h1>
        ${editing ? `<div class="detail-meta" style="margin-top:8px">${UI.auditMetaHtml(user)}</div>` : ''}
      </div></div>
      <div class="card card-pad" style="max-width:560px">
        <form id="user-form" novalidate>
          <div class="field${errors.name ? ' has-error' : ''}">
            <label>Name <span class="req">*</span></label>
            <input type="text" id="f-name" value="${UI.esc(state.name)}">
            ${errors.name ? `<div class="error">${errors.name}</div>` : ''}
          </div>
          <div class="field${errors.email ? ' has-error' : ''}">
            <label>Email <span class="req">*</span></label>
            <input type="email" id="f-email" value="${UI.esc(state.email)}">
            ${errors.email ? `<div class="error">${errors.email}</div>` : ''}
          </div>
          <div class="field">
            <label>Role <span class="req">*</span></label>
            <select id="f-role">
              <option value="staff" ${state.role === 'staff' ? 'selected' : ''}>Staff</option>
              <option value="owner" ${state.role === 'owner' ? 'selected' : ''}>Owner</option>
            </select>
          </div>
          ${!editing ? `
          <div class="field${errors.password ? ' has-error' : ''}">
            <label>Initial Password <span class="req">*</span></label>
            <input type="text" id="f-password" value="${UI.esc(state.password)}" autocomplete="new-password">
            <div class="hint">At least 8 characters. Tell the new user this password directly — there's no email confirmation to fall back on.</div>
            ${errors.password ? `<div class="error">${errors.password}</div>` : ''}
          </div>` : ''}
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${editing ? 'Save Changes' : 'Create User'}</button>
            <a class="btn btn-secondary" href="#/users">Cancel</a>
          </div>
        </form>
      </div>
      ${editing ? resetPasswordSectionHtml() : ''}`;
    attach();
  }

  // A separate action, not a field on the main form above — resetting a password and
  // editing an account's attributes are two different operations with two different
  // consequences (docs/phase-6-plan.md §1 "PATCH /users/:id/password is a *reset*,
  // not a *recovery*").
  function resetPasswordSectionHtml(){
    return `
      <h2 class="section-title">Reset Password</h2>
      <div class="card card-pad" style="max-width:560px">
        <div class="sub" style="margin-bottom:14px">Sets a new password immediately. ${UI.esc(user.name)} isn't notified — tell them the new password directly.</div>
        <form id="reset-pw-form" novalidate>
          <div class="field${pwErrors.newPassword ? ' has-error' : ''}">
            <label>New Password <span class="req">*</span></label>
            <input type="text" id="f-new-password" value="${UI.esc(pw.newPassword)}" autocomplete="new-password">
            ${pwErrors.newPassword ? `<div class="error">${pwErrors.newPassword}</div>` : ''}
          </div>
          <div class="field${pwErrors.confirm ? ' has-error' : ''}">
            <label>Confirm New Password <span class="req">*</span></label>
            <input type="text" id="f-confirm-password" value="${UI.esc(pw.confirm)}" autocomplete="new-password">
            ${pwErrors.confirm ? `<div class="error">${pwErrors.confirm}</div>` : ''}
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-secondary" ${pwSubmitting ? 'disabled' : ''}>${pwSubmitting ? 'Resetting…' : 'Reset Password'}</button>
          </div>
        </form>
      </div>`;
  }

  function validate(){
    const e = {};
    if (!state.name.trim()) e.name = 'Name is required.';
    if (!state.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.email.trim())) e.email = 'Enter a valid email address.';
    if (!editing && state.password.length < 8) e.password = 'Password must be at least 8 characters.';
    return e;
  }
  function validatePw(){
    const e = {};
    if (pw.newPassword.length < 8) e.newPassword = 'Password must be at least 8 characters.';
    // Confirm-match is checked client-side only — the server has no opinion about a
    // field (the confirm field) it never receives (docs/phase-6-plan.md §3).
    if (pw.confirm !== pw.newPassword) e.confirm = 'Passwords do not match.';
    return e;
  }

  function attach(){
    container.querySelector('#user-form').addEventListener('submit', e => {
      e.preventDefault();
      state.name = container.querySelector('#f-name').value;
      state.email = container.querySelector('#f-email').value;
      state.role = container.querySelector('#f-role').value;
      if (!editing) state.password = container.querySelector('#f-password').value;
      errors = validate();
      if (Object.keys(errors).length){ render(); return; }
      const save = editing ? Store.updateUser(id, state) : Store.createUser(state);
      save.then(() => {
        UI.toast(editing ? 'User updated.' : 'User created.', 'success');
        UI.navigate('#/users');
      }).catch(err => { UI.toast(err.message, 'error'); });
    });

    const pwForm = container.querySelector('#reset-pw-form');
    if (pwForm){
      pwForm.addEventListener('submit', e => {
        e.preventDefault();
        pw.newPassword = container.querySelector('#f-new-password').value;
        pw.confirm = container.querySelector('#f-confirm-password').value;
        pwErrors = validatePw();
        if (Object.keys(pwErrors).length){ render(); return; }
        pwSubmitting = true; render();
        Store.resetUserPassword(id, pw.newPassword).then(() => {
          UI.toast(`Password reset for ${user.name}.`, 'success');
          pw = { newPassword: '', confirm: '' }; pwErrors = {}; pwSubmitting = false;
          render();
        }).catch(err => { pwSubmitting = false; UI.toast(err.message, 'error'); render(); });
      });
    }
  }

  load();
}
