// The two screens that live outside the app shell's normal resource grouping: the
// login form (rendered before there's a session) and the self-service account
// screen (the one non-dashboard route open to both roles equally).

import { UI } from '../ui.js';
import { Store } from '../api.js';
import { renderApp } from '../router.js';

// -------------------------------------------------------------- Login --
// FR-060. Replaces Phase 1's static "Signed in as Jordan Lee · Staff" chip
// (ui-open-questions.md Q-UI-4) with a real credential form — see
// docs/phase-3-plan.md §3 "Frontend changes". Rendered outside the app shell
// entirely (no sidebar/topbar — there's nothing to navigate to yet), and reachable
// only through renderApp()'s auth gate, never a nav link.
export function login(container){
  let submitting = false;
  let error = null;

  function render(){
    container.innerHTML = `
      <div class="login-page">
        <div class="card card-pad login-card">
          <div class="login-brand">
            <div class="wordmark">Smart<span>Inventory</span></div>
            <div class="tagline">Manager</div>
          </div>
          <h1>Sign in</h1>
          <div class="sub" style="margin-bottom:18px">Use your Smart Inventory Manager account to continue.</div>
          ${error ? `<div class="inline-notice warn" style="margin-bottom:14px">${UI.icon('warning')}<span>${UI.esc(error)}</span></div>` : ''}
          <form id="login-form">
            <div class="field">
              <label for="lf-email">Email <span class="req">*</span></label>
              <input type="email" id="lf-email" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="lf-password">Password <span class="req">*</span></label>
              <input type="password" id="lf-password" autocomplete="current-password" required>
            </div>
            <div class="form-actions">
              <button class="btn btn-primary btn-block" type="submit" ${submitting ? 'disabled' : ''}>${submitting ? 'Signing in…' : 'Sign in'}</button>
            </div>
          </form>
        </div>
      </div>`;
    attach();
  }

  function attach(){
    const form = container.querySelector('#login-form');
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (submitting) return;
      const email = container.querySelector('#lf-email').value.trim();
      const password = container.querySelector('#lf-password').value;
      submitting = true;
      error = null;
      render();
      Store.login(email, password)
        .then(() => {
          // Usually a hash change (from '#/login' or empty) fires renderApp() via
          // the hashchange listener on its own — but if the address bar already
          // read '#/dashboard' (e.g. the user typed that URL while logged out),
          // setting the same hash again is a no-op that fires no event, so render
          // directly in that one case instead of leaving the login form on screen.
          if (location.hash === '#/dashboard') renderApp();
          else UI.navigate('#/dashboard');
        })
        .catch(err => {
          submitting = false;
          error = err.message || 'Could not sign in. Please try again.';
          render();
        });
    });
    container.querySelector('#lf-email').focus();
  }

  render();
}

// -------------------------------------------------------------- Account (self-service) --
// FR-064 (docs/phase-6-plan.md §3 "Views.account"). The one non-dashboard route open
// to both roles equally — reachable from the user chip, not gated by isOwnerOnlyRoute.
export function account(container){
  const state = { currentPassword: '', newPassword: '', confirm: '' };
  let errors = {};
  let submitting = false;

  function render(){
    container.innerHTML = `
      <div class="content-header"><div><h1>My Account</h1><div class="sub">Change the password for your own account.</div></div></div>
      <div class="card card-pad" style="max-width:420px">
        <form id="account-form" novalidate>
          <div class="field${errors.currentPassword ? ' has-error' : ''}">
            <label>Current Password <span class="req">*</span></label>
            <input type="password" id="f-current" autocomplete="current-password" value="${UI.esc(state.currentPassword)}">
            ${errors.currentPassword ? `<div class="error">${errors.currentPassword}</div>` : ''}
          </div>
          <div class="field${errors.newPassword ? ' has-error' : ''}">
            <label>New Password <span class="req">*</span></label>
            <input type="password" id="f-new" autocomplete="new-password" value="${UI.esc(state.newPassword)}">
            ${errors.newPassword ? `<div class="error">${errors.newPassword}</div>` : ''}
          </div>
          <div class="field${errors.confirm ? ' has-error' : ''}">
            <label>Confirm New Password <span class="req">*</span></label>
            <input type="password" id="f-confirm" autocomplete="new-password" value="${UI.esc(state.confirm)}">
            ${errors.confirm ? `<div class="error">${errors.confirm}</div>` : ''}
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" ${submitting ? 'disabled' : ''}>${submitting ? 'Changing…' : 'Change Password'}</button>
          </div>
        </form>
      </div>`;
    attach();
  }

  function validate(){
    const e = {};
    if (!state.currentPassword) e.currentPassword = 'Current password is required.';
    if (state.newPassword.length < 8) e.newPassword = 'Password must be at least 8 characters.';
    // Confirm-match is client-side only — the server never receives this field.
    if (state.confirm !== state.newPassword) e.confirm = 'Passwords do not match.';
    return e;
  }

  function attach(){
    container.querySelector('#account-form').addEventListener('submit', e => {
      e.preventDefault();
      state.currentPassword = container.querySelector('#f-current').value;
      state.newPassword = container.querySelector('#f-new').value;
      state.confirm = container.querySelector('#f-confirm').value;
      errors = validate();
      if (Object.keys(errors).length){ render(); return; }
      submitting = true; render();
      Store.changeOwnPassword(state.currentPassword, state.newPassword).then(() => {
        UI.toast('Password changed.', 'success');
        state.currentPassword = ''; state.newPassword = ''; state.confirm = '';
        submitting = false;
        render();
      }).catch(err => {
        // The server's 401 for a wrong current password surfaces here exactly like
        // any other inline form error, not a session expiry — Store._request
        // disambiguates the two by probing /auth/me before deciding whether to log
        // out (see that comment).
        submitting = false;
        errors = { currentPassword: err.message };
        render();
      });
    });
  }

  render();
}
