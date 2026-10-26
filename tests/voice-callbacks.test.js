import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Retell's call webhook and custom-function (tool) callbacks are public URLs.
// Only requests Retell signed may act, and whatever they do lands in the
// account that owns the lead — never in whichever account a payload names.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-voice-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { default: voiceRouter } = await import('../src/routes/voice.js');
const { signRetell } = await import('../src/services/ingest-auth.js');

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const KEY = 'key_test_retell_0123456789';

function reset() {
  for (const t of ['appointments', 'activities', 'leads', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice_ai_api_key', ?)").run(KEY);
  for (const id of [1, 2]) {
    db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')`)
      .run(id, `user${id}`, `owner${id}@example.com`);
  }
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (20, 2, 'Grace Tan', 'grace@prospect.example', 'Lumina', 'new')").run();
}
beforeEach(reset);

async function withServer(fn) {
  const app = express();
  // Mirrors server.js: raw bytes on the signed paths, parsed JSON elsewhere.
  app.use(['/api/voice/webhook', '/api/voice/tool-callback'], express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, payload, { sign = true, ts = Date.now(), key = KEY, header } = {}) => {
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json' };
    if (header !== undefined) headers['x-retell-signature'] = header;
    else if (sign) headers['x-retell-signature'] = signRetell(key, body, ts);
    const res = await fetch(base + p, { method: 'POST', headers, body });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  try { await fn(post); } finally { server.close(); }
}

const overview = { name: 'send_overview', args: {}, call: { call_id: 'c1', metadata: { lead_id: '20' } } };
const meeting = (metadata) => ({ name: 'schedule_meeting', args: { date_time: 'Thursday at 3pm', duration: '30' }, call: { call_id: 'c2', metadata } });

test('unsigned, forged, stale and wrong-key callbacks are refused and change nothing', async () => {
  await withServer(async (post) => {
    assert.equal((await post('/api/voice/tool-callback', overview, { sign: false })).status, 401);
    assert.equal((await post('/api/voice/tool-callback', overview, { header: 'v=1,d=00' })).status, 401);
    assert.equal((await post('/api/voice/tool-callback', overview, { ts: Date.now() - 6 * 60 * 1000 })).status, 401);
    assert.equal((await post('/api/voice/tool-callback', overview, { key: 'some-other-key' })).status, 401);
    const hook = { event: 'call_ended', call: { call_id: 'x', metadata: { lead_id: '20' }, call_analysis: { user_sentiment: 'Positive', call_summary: 'Meeting booked' } } };
    assert.equal((await post('/api/voice/webhook', hook, { sign: false })).status, 401);
  });
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = 20').get().status, 'new');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM appointments').get().c, 0);
});

test('with no Retell key configured the callbacks fail closed', async () => {
  db.prepare("DELETE FROM settings WHERE key = 'voice_ai_api_key'").run();
  await withServer(async (post) => {
    assert.equal((await post('/api/voice/tool-callback', overview)).status, 503);
  });
});

test('a signed callback works, and never reads a lead email back to the caller', async () => {
  await withServer(async (post) => {
    const res = await post('/api/voice/tool-callback', overview);
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /grace@prospect\.example/);
  });
});

test("a booking lands in the lead owner's account, whatever the metadata claims", async () => {
  await withServer(async (post) => {
    assert.equal((await post('/api/voice/tool-callback', meeting({ lead_id: '20' }))).status, 200);
    assert.equal((await post('/api/voice/tool-callback', { ...meeting({ lead_id: '20', user_id: '1' }), call: { call_id: 'c3', metadata: { lead_id: '20', user_id: '1' } } })).status, 200);
  });
  const owners = db.prepare('SELECT DISTINCT user_id FROM appointments').all().map(r => r.user_id);
  assert.deepEqual(owners, [2]);
});

test('a signed webhook updates the lead', async () => {
  await withServer(async (post) => {
    const hook = { event: 'call_ended', call: { call_id: 'x', metadata: { lead_id: '20' }, call_analysis: { user_sentiment: 'Positive', call_summary: 'Interested' } } };
    assert.equal((await post('/api/voice/webhook', hook)).status, 200);
  });
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = 20').get().status, 'qualified');
});
