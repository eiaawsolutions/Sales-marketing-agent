// The version stamp on app.js in public/app.html (`/app.js?v=...`). /api/health
// reports it so a browser tab left open across a deploy can tell it is still
// running the old page and ask to be reloaded.
export function appVersionFrom(html) {
  const m = String(html || '').match(/\/app\.js\?v=([^"'&\s]+)/);
  return m ? m[1] : null;
}
