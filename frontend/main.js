// The entry module: registers the two window listeners the app needs and kicks off
// the first render. Everything else is reached through router.js's imports.

import { renderApp } from './router.js';

window.addEventListener('hashchange', renderApp);

// Phase 2 fetched reference data (categories + a demo "current user") before the very
// first render, since nothing was gated on authentication yet. Phase 3 flips that:
// every endpoint except POST /auth/login now requires a token nothing has yet (see
// docs/phase-3-plan.md), so there is nothing safe to fetch before the user has
// actually signed in — renderApp()'s own auth gate handles showing the login screen,
// and Store.login() is what fetches categories once a token exists. boot() just
// needs to kick off that first render; if the API turns out to be unreachable, the
// login form surfaces that itself the moment someone submits it (Views.login).
function boot(){
  renderApp();
}

// A module script is deferred, so DOMContentLoaded has usually fired by the time this
// runs — but the guard costs nothing and keeps both cases correct.
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else boot(); // script ran after DOMContentLoaded already fired
