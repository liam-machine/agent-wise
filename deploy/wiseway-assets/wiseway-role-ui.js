/* =============================================================================
 * Wiseway Staff Assistant — login gate + role-scoped UI boot script
 * =============================================================================
 * Loaded as a classic <script> in <head> (runs before the React module bundle).
 *
 * TWO jobs:
 *  1) LOGIN GATE (demo). Replaces OIDC with a dead-simple box: choose User or
 *     Admin, type the demo password, and we sign in to the matching account via
 *     LibreChat's own /api/auth/login. The user types "user"/"admin"; the stored
 *     account passwords are longer (LibreChat enforces >= 8 chars) and live here.
 *     *** DEMO ONLY — this is a presentation gate, NOT real security. ***
 *  2) ROLE-SCOPED UI. For blue-collar roles it tags <html data-wiseway-ui="minimal">
 *     so wiseway-role-ui.css strips the nav to New Chat + Chat History. Role is the
 *     SAME string used for MCP doc-scoping (read from /api/user).
 *
 * Fully reversible: remove the three asset mounts (css/js/index.html).
 * ===========================================================================*/
(function () {
  'use strict';

  // Roles that get the stripped-down shop-floor UI.
  var MINIMAL_ROLES = ['warehouse', 'driver'];

  // Demo accounts. `demo` is what the user types; `password` is the real (>=8
  // char) account secret used for the actual login. DEMO ONLY.
  var ACCOUNTS = {
    user:  { email: 'user@wiseway.demo',  password: 'wisewayuser',  demo: 'user'  },
    admin: { email: 'admin@wiseway.demo', password: 'wisewayadmin', demo: 'admin' }
  };

  var STORAGE_KEY = 'wiseway-ui-mode';
  var root = document.documentElement;

  function setMode(minimal) {
    if (minimal) root.setAttribute('data-wiseway-ui', 'minimal');
    else root.removeAttribute('data-wiseway-ui');
    try { localStorage.setItem(STORAGE_KEY, minimal ? 'minimal' : 'full'); } catch (e) {}
  }

  // Instant apply from cache — avoids a flash of the full UI on repeat loads.
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'minimal') root.setAttribute('data-wiseway-ui', 'minimal');
  } catch (e) {}

  function whenBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // --- login overlay ---------------------------------------------------------
  function mountOverlay() {
    if (document.getElementById('wiseway-login')) return;
    var ov = document.createElement('div');
    ov.id = 'wiseway-login';
    ov.innerHTML =
      '<div class="wl-card">' +
      '  <img class="wl-logo" src="/assets/icon-192x192.png" alt="Wiseway"/>' +
      '  <div class="wl-title">Wiseway Staff Assistant</div>' +
      '  <div class="wl-sub">Select your access, then enter the password.</div>' +
      '  <div class="wl-roles">' +
      '    <button type="button" class="wl-role wl-on" data-role="user">User</button>' +
      '    <button type="button" class="wl-role" data-role="admin">Admin</button>' +
      '  </div>' +
      '  <input class="wl-pw" type="password" placeholder="Password" autocomplete="off" autocapitalize="off" spellcheck="false"/>' +
      '  <button class="wl-go" type="button">Sign in</button>' +
      '  <div class="wl-err"></div>' +
      '  <div class="wl-hint">Demo passwords — User: <b>user</b> · Admin: <b>admin</b></div>' +
      '</div>';
    (document.body || root).appendChild(ov);

    var selected = 'user';
    var pw = ov.querySelector('.wl-pw');
    var err = ov.querySelector('.wl-err');
    var roleBtns = ov.querySelectorAll('.wl-role');

    Array.prototype.forEach.call(roleBtns, function (b) {
      b.addEventListener('click', function () {
        selected = b.getAttribute('data-role');
        Array.prototype.forEach.call(roleBtns, function (x) { x.classList.remove('wl-on'); });
        b.classList.add('wl-on');
        err.textContent = '';
        pw.focus();
      });
    });

    function submit() {
      err.textContent = '';
      var acct = ACCOUNTS[selected];
      if (pw.value !== acct.demo) { err.textContent = 'Incorrect password.'; pw.select(); return; }
      ov.classList.add('wl-busy');
      fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: acct.email, password: acct.password })
      }).then(function (r) {
        if (r.ok) { window.location.assign('/c/new'); }
        else { ov.classList.remove('wl-busy'); err.textContent = 'Sign-in failed.'; }
      }).catch(function () { ov.classList.remove('wl-busy'); err.textContent = 'Sign-in failed.'; });
    }

    ov.querySelector('.wl-go').addEventListener('click', submit);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    setTimeout(function () { pw.focus(); }, 60);
  }

  function removeOverlay() {
    var ov = document.getElementById('wiseway-login');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  // --- role UI (only on app routes, where the user IS signed in) -------------
  // Access token lives only in memory, so mint one from the httpOnly refresh
  // cookie, then read the role from /api/user.
  function applyRoleUi() {
    return fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.token) { setMode(false); return null; }
        return fetch('/api/user', { headers: { Authorization: 'Bearer ' + data.token } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (user) {
            var role = (user && user.role ? String(user.role) : '').toLowerCase();
            setMode(MINIMAL_ROLES.indexOf(role) !== -1);
          });
      })
      .catch(function () { /* keep cached value on transient error */ });
  }

  // --- gate driver -----------------------------------------------------------
  // /login (incl. after logout) => show OUR box over LibreChat's native form.
  // IMPORTANT: do NOT call /api/auth/refresh while on /login — that would renew
  // a just-logged-out session and bounce the user back in (the logout bug).
  function tick() {
    if (/^\/login\b/.test(window.location.pathname)) {
      root.setAttribute('data-wiseway-auth', 'out');
      setMode(false);
      whenBody(mountOverlay);
    } else {
      root.setAttribute('data-wiseway-auth', 'in');
      removeOverlay();
      applyRoleUi();
    }
  }

  tick();
  setInterval(tick, 1000);
})();
