// Fork B (docs/phase-13-plan.md §1): the module that owns the in-memory session
// state. In the single-file version these were two module-level `let`s that one
// function mutated and another read; across ES modules an imported binding is a
// live, read-only view, so the writers cannot reassign it from another file. The
// fix is not a shared mutable object (that just hides the same unrestricted
// mutation across a file boundary) but accessor functions: the writers are the
// callers of setCurrentUser / setAccessToken / clearSession, and they are
// greppable. There are two — Store.login and Store.logout — plus Store._request's
// dead-session path.

let currentUser = null;   // { id, name, role } — set by Store.login(), cleared by Store.logout()

// Phase 3 (docs/phase-3-plan.md "Token transport"): held in a plain JS variable, not
// localStorage — matching how the rest of Store already avoids persisting anything
// client-side. The one consequence worth stating plainly: a page refresh loses this
// and logs the user out. That's an accepted MVP tradeoff for a single-page tool with
// no build step, not a bug.
let accessToken = null;

export function getCurrentUser(){ return currentUser; }
export function setCurrentUser(user){ currentUser = user; }

export function getAccessToken(){ return accessToken; }
export function setAccessToken(token){ accessToken = token; }

// Clears everything the session holds. Store.logout() and the 401 handling in
// Store._request both end here.
export function clearSession(){
  currentUser = null;
  accessToken = null;
}

// Phase 5 (docs/phase-5-plan.md §3): the one place the 'owner' string literal
// appears. The server is the actual enforcement point (RolesGuard) — this only
// decides what the UI offers, so a Staff user isn't shown a button that will 403.
// currentUser is held in memory only (no localStorage, per Phase 3), so this can
// never read a stale role left over from a previous session.
export function isOwner(){
  return !!currentUser && currentUser.role === 'owner';
}
