import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The page's request helper (public/app.js). While Railway swaps in a new
// version of a service with a volume, requests get its own 502 page, not
// JSON. On 29 Oct 2026 "Review my pipeline" landed in that window and the
// page showed a JSON parse error instead of saying what happened.
function page(answer) {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function apiRequest(');
  const ctx = {
    authToken: 't', currentUser: null, sessionStorage: { removeItem() {}, setItem() {} }, render() {},
    versionChecks: 0, checkAppVersion() { ctx.versionChecks++; },
    fetch: async () => { if (answer instanceof Error) throw answer; return answer; },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(i, src.indexOf('\n}\n', i) + 3), ctx);
  return ctx;
}
const reply = (status, body) => ({
  status, ok: status < 400, clone() { return this; },
  json: async () => { if (typeof body !== 'object') throw new SyntaxError(`Unexpected token '<', "${body}" is not valid JSON`); return body; },
});

test('a request cut off by an update says so, and checks for the new version', async () => {
  for (const status of [502, 503, 504]) {
    const p = page(reply(status, '<html>Application failed to respond</html>'));
    await assert.rejects(p.apiRequest('/pipeline/brief', { method: 'POST' }), (e) => /updat/i.test(e.message) && /try again/i.test(e.message) && !/JSON|token/.test(e.message));
    assert.equal(p.versionChecks, 1);
  }
});

test('a request that never reaches the server says so in plain words', async () => {
  const p = page(new TypeError('Failed to fetch'));
  await assert.rejects(p.apiRequest('/pipeline/brief', { method: 'POST' }), (e) => /reach/i.test(e.message) && /try again/i.test(e.message));
});

test('answers the server writes itself are unchanged', async () => {
  assert.deepEqual({ ...(await page(reply(200, { ok: true })).apiRequest('/x')) }, { ok: true });
  await assert.rejects(page(reply(403, { error: 'AI action limit reached' })).apiRequest('/x'), /AI action limit reached/);
  await assert.rejects(page(reply(500, '<html>oops</html>')).apiRequest('/x'), /Request failed \(500\)/);
});
