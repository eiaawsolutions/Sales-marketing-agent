import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// On 29 Oct 2026 a browser tab opened before a deploy kept running the old
// campaign wizard: its Preview showed the designer's starter email, and going
// back to Content would have put that starter over the real email and let
// "Save & Send Now" send it. The server now refuses both, whatever code the
// tab runs, and the page asks to be reloaded when the app has been updated.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-starter-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.OUTREACH_SEND_GAP_MS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { campaignsService, isStarterEmail } = await import('../src/services/campaigns.js');
const { appVersionFrom } = await import('../src/utils/app-version.js');

const realFetch = globalThis.fetch;
let sent = [];
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

// The designer's starter email, exactly as public/email-designer.js compiles it.
const designer = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://sa.eiaawsolutions.com/app', runScripts: 'outside-only' }).window;
designer.eval(readFileSync(new URL('../public/email-designer.js', import.meta.url), 'utf8'));
const STARTER = designer.EmailDesigner.compile(designer.EmailDesigner.defaultDesign());
const REAL = '<html><body><p>AI that does the work. Your team makes the decisions.</p></body></html>';

beforeEach(() => {
  for (const t of ['activities', 'campaign_leads', 'leads', 'campaigns', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'amos', 'amos@example.com', 'x', 'user', 'active', 'business')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, status) VALUES (20, 2, 'Lead', 'lead@example.com', 'new')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
});

test("the server knows the designer's starter email when it sees one", () => {
  assert.equal(isStarterEmail(STARTER), true);
  assert.equal(isStarterEmail(REAL), false);
  assert.equal(isStarterEmail(''), false);
});

test('a saved email is never replaced by the starter email', () => {
  const c = campaignsService.create(2, { name: 'Brief', type: 'email', subject: 'Hi', body: REAL });
  assert.throws(() => campaignsService.update(2, c.id, { body: STARTER }), /sample text/);
  assert.equal(campaignsService.getById(2, c.id).body, REAL);
  campaignsService.update(2, c.id, { body: REAL.replace('work', 'busywork') });
  assert.match(campaignsService.getById(2, c.id).body, /busywork/);
});

test('a new campaign still being written can be saved with the starter email', () => {
  const c = campaignsService.create(2, { name: 'Draft', type: 'email', subject: 'Hi', body: STARTER });
  campaignsService.update(2, c.id, { body: STARTER, subject: 'Hello' });
  assert.equal(campaignsService.getById(2, c.id).subject, 'Hello');
  const empty = campaignsService.create(2, { name: 'Empty', type: 'email', subject: 'Hi', body: '' });
  campaignsService.update(2, empty.id, { body: STARTER });
  assert.equal(isStarterEmail(campaignsService.getById(2, empty.id).body), true);
});

test('the starter email is never sent to a lead', async () => {
  const c = campaignsService.create(2, { name: 'Draft', type: 'email', subject: 'Hi', body: STARTER });
  campaignsService.addLeads(c.id, [20]);
  await assert.rejects(campaignsService.sendCampaign(2, c.id), /sample text/);
  assert.equal(sent.length, 0);
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = 20').get(c.id).status, 'pending');

  campaignsService.update(2, c.id, { body: REAL });
  const r = await campaignsService.sendCampaign(2, c.id);
  assert.equal(r.sent, 1);
});

test('the server reports the app version the page is built with', () => {
  const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const v = appVersionFrom(html);
  assert.ok(v, 'app.html carries a version on app.js');
  assert.ok(html.includes(`/app.js?v=${v}"`));
  assert.equal(appVersionFrom('<script src="/other.js?v=1"></script>'), null);
  assert.equal(appVersionFrom(''), null);
});

// The page side (public/app.js): a tab running an older app.js than the
// server now serves asks to be reloaded; an up-to-date tab says nothing.
async function pageAfterCheck(loaded, served) {
  const w = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://sa.eiaawsolutions.com/app', runScripts: 'outside-only' }).window;
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function checkAppVersion(');
  w.fetch = async () => ({ json: async () => ({ status: 'ok', appVersion: served }) });
  w.eval(`var APP_VERSION = ${JSON.stringify(loaded)};\n${src.slice(i, src.indexOf('\n}\n', i) + 3)}`);
  await w.checkAppVersion();
  return w.document;
}

test('a tab left open across a deploy asks to be reloaded', async () => {
  const doc = await pageAfterCheck('20261029-design', '20261029-guard');
  const notice = doc.getElementById('app-update-notice');
  assert.ok(notice, 'the update notice is shown');
  assert.match(notice.textContent, /updated/i);
  assert.ok(notice.querySelector('button'), 'with a Reload button');
  assert.equal((await pageAfterCheck('20261029-guard', '20261029-guard')).getElementById('app-update-notice'), null);
  assert.equal((await pageAfterCheck('20261029-guard', undefined)).getElementById('app-update-notice'), null);
});
