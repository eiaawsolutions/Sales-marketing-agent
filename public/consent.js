/* ============================================================
   EIAAW Sales Agent — consent gate + cookie banner
   Loaded synchronously in <head>, before anything else can track.

   Nothing third-party that tracks visitors loads until they opt in
   (Thailand, Vietnam, Indonesia, Korea and China expect prior consent for
   non-essential tracking; it is also the safe reading of Malaysia's PDPA).
   This site only uses the Meta Pixel (advertising). The choice is stored in
   the same `eiaaw_consent` cookie on .eiaawsolutions.com that
   eiaawsolutions.com and smt.eiaawsolutions.com use, so a visitor chooses
   once across EIAAW sites.
   ============================================================ */
(function () {
  var META_ID = '1516303113491153';
  var KEY = 'eiaawConsent';
  var COOKIE = 'eiaaw_consent';
  var VERSION = 1;
  var SHARED = /(^|\.)eiaawsolutions\.com$/.test(location.hostname);

  function loadMeta() {
    if (window.fbq) { window.fbq('consent', 'grant'); return; }
    /* Standard Meta Pixel bootstrap */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_ID);
    window.fbq('track', 'PageView');
  }

  function apply(c) {
    if (c.ads) loadMeta();
    else if (window.fbq) window.fbq('consent', 'revoke');
  }

  function valid(c) { return c && c.v === VERSION ? c : null; }

  function read() {
    var m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)'));
    if (m) {
      try { var fromCookie = valid(JSON.parse(decodeURIComponent(m[1]))); if (fromCookie) return fromCookie; } catch (e) { /* fall through */ }
    }
    try { return valid(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (e) { return null; }
  }

  function save(analytics, ads) {
    var c = { v: VERSION, analytics: !!analytics, ads: !!ads, ts: new Date().toISOString() };
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* private mode */ }
    document.cookie = COOKIE + '=' + encodeURIComponent(JSON.stringify(c)) + '; max-age=15552000; path=/; SameSite=Lax' +
      (SHARED ? '; domain=.eiaawsolutions.com' : '') + (location.protocol === 'https:' ? '; Secure' : '');
    apply(c);
    return c;
  }

  // ---------- Banner (equal weight for yes and no) ----------
  var CSS = '.eiaaw-cookie{position:fixed;left:20px;bottom:20px;z-index:280;max-width:540px;padding:20px 22px;background:#fff;' +
    'border:1px solid #D9CFBC;border-radius:18px;box-shadow:0 18px 48px -16px rgba(15,26,29,.28);font-family:Inter,-apple-system,"Segoe UI",sans-serif;color:#2A3438}' +
    '.eiaaw-cookie[hidden]{display:none}.eiaaw-cookie p{margin:0 0 14px;font-size:14px;line-height:1.55}.eiaaw-cookie strong{color:#0F1A1D}' +
    '.eiaaw-cookie a{color:#11766A;text-decoration:underline}.eiaaw-cookie-actions{display:flex;flex-wrap:wrap;gap:10px}' +
    '.eiaaw-cookie button{font:600 13px/1 Inter,-apple-system,"Segoe UI",sans-serif;padding:11px 18px;border-radius:999px;cursor:pointer;border:1px solid #0F1A1D;background:transparent;color:#0F1A1D}' +
    '.eiaaw-cookie button.primary{background:#0F1A1D;color:#fff}.eiaaw-cookie button:focus-visible{outline:2px solid #1FA896;outline-offset:2px}' +
    '@media (max-width:680px){.eiaaw-cookie{left:12px;right:12px;bottom:100px;max-width:none}.eiaaw-cookie button{flex:1 1 auto}}';

  function showBanner() {
    var bar = document.getElementById('eiaaw-cookie');
    if (!bar) {
      var style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      bar = document.createElement('div');
      bar.id = 'eiaaw-cookie';
      bar.className = 'eiaaw-cookie';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Cookie choices');
      bar.innerHTML =
        '<p><strong>Your choice.</strong> With your permission we use a cookie to measure our ads (Meta). ' +
        'The same choice applies across EIAAW sites, some of which also use Google Analytics. Nothing loads unless you say yes. ' +
        '<a href="/privacy.html#cookies">Details</a></p>' +
        '<div class="eiaaw-cookie-actions">' +
        '<button type="button" class="primary" data-consent="all">Accept all</button>' +
        '<button type="button" data-consent="none">Reject all</button></div>';
      bar.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('[data-consent]');
        if (!btn) return;
        var yes = btn.getAttribute('data-consent') === 'all';
        save(yes, yes);
        bar.hidden = true;
      });
      document.body.appendChild(bar);
    }
    bar.hidden = false;
  }

  window.EIAAWConsent = { get: read, set: save, show: showBanner };

  var saved = read();
  if (saved) apply(saved);

  function onReady() {
    if (!read()) showBanner();
    if ((location.hash || '').toLowerCase() === '#cookies') showBanner();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // Any element with data-cookie-settings reopens the banner (footer link).
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-cookie-settings]');
    if (!t) return;
    e.preventDefault();
    showBanner();
  });
  window.addEventListener('hashchange', function () {
    if ((location.hash || '').toLowerCase() === '#cookies') showBanner();
  });
})();
