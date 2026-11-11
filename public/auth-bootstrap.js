/* Runs synchronously before application or third-party scripts. */
(function () {
  "use strict";
  var url = new URL(window.location.href);
  var fragment = new URLSearchParams(url.hash.slice(1));
  var returned;
  function sessionToken(value, type) {
    try {
      if (!value || value.length > 16384) return null;
      var parts = value.split('.');
      if (parts.length !== 3) return null;
      var payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), function (c) { return c.charCodeAt(0); })));
      return payload.v === 2 && payload.aud === 'noitamap-auth' && payload.typ === type
        && typeof payload.sid === 'string' && /^[a-f0-9-]{36}$/.test(payload.sid) ? payload : null;
    } catch (_) { return null; }
  }
  try {
    if (localStorage.getItem("noitamap_session_format") !== "2") {
      localStorage.removeItem("noitamap_jwt");
      localStorage.removeItem("noitamap_refresh_jwt");
      sessionStorage.removeItem("noitamap_pending_account_link");
      sessionStorage.removeItem("noitamap_login_nonce_v2");
      localStorage.setItem("noitamap_session_format", "2");
    }
    var oldAccess = localStorage.getItem('noitamap_jwt');
    var oldRefresh = localStorage.getItem('noitamap_refresh_jwt');
    if (oldAccess && !sessionToken(oldAccess, 'access') || oldRefresh && !sessionToken(oldRefresh, 'refresh')) {
      localStorage.removeItem('noitamap_jwt'); localStorage.removeItem('noitamap_refresh_jwt');
    }
    var pending = JSON.parse(sessionStorage.getItem("noitamap_login_nonce_v2") || "null");
    var nonce = url.searchParams.get("auth_nonce");
    var matches = pending && typeof pending.nonce === "string" && /^[a-f0-9]{64}$/.test(pending.nonce)
      && nonce === pending.nonce && pending.origin === url.origin && pending.path === url.pathname
      && Number.isFinite(pending.createdAt) && pending.createdAt <= Date.now()
      && Date.now() - pending.createdAt <= 600000;
    if (matches) {
      sessionStorage.removeItem("noitamap_login_nonce_v2");
      var token = fragment.get("token");
      var refresh = fragment.get("refresh_token");
      var link = fragment.get("link_token");
      var accessClaims = sessionToken(token, 'access'), refreshClaims = sessionToken(refresh, 'refresh');
      if (fragment.get("auth") === "success" && accessClaims && refreshClaims && accessClaims.sid === refreshClaims.sid) {
        localStorage.setItem("noitamap_jwt", token);
        localStorage.setItem("noitamap_refresh_jwt", refresh);
        returned = { success: true };
      } else if (fragment.get("auth") === "linked" && link && /^[A-Za-z0-9_-]{32,100}$/.test(link)) {
        returned = { linkToken: link };
      }
    }
    var error = url.searchParams.get("auth_error");
    if (matches && error && /^[a-z_]{1,80}$/.test(error)) returned = { error: error };
  } catch (_) {
    // Unavailable storage must never leave credentials in the address bar.
  }
  var changed = false, fragmentChanged = false;
  ["auth", "token", "refresh_token", "link_token", "auth_error", "auth_nonce"].forEach(function (name) {
    if (url.searchParams.has(name)) { url.searchParams.delete(name); changed = true; }
    if (fragment.has(name)) { fragment.delete(name); changed = true; fragmentChanged = true; }
  });
  if (changed) {
    if (fragmentChanged) url.hash = fragment.toString();
    window.history.replaceState(window.history.state, "", url.href);
  }
  Object.defineProperty(window, "__noitamapAuthReturn", { value: returned, configurable: true });
})();
