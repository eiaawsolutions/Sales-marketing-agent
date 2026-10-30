import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// One Retell account serves every EIAAW site. When its credit runs out, every
// "Talk to the agent" button must disappear rather than hand visitors an
// error, and come back by itself once the account is topped up.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-voiceline-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { default: voiceRouter } = await import('../src/routes/voice.js');
const { voiceAvailable, pauseVoice, checkVoiceLine } = await import('../src/services/voice-availability.js');
const { buildChatbotPrompt } = await import('../src/prompts/chatbot.js');
const { signRetell } = await import('../src/services/ingest-auth.js');
const { FOUNDER_HQ_EMAIL } = await import('../src/config/hq.js');

const KEY = 'key_test_retell_0123456789';
const OK = () => new Response(JSON.stringify({ call_id: 'call_ok', access_token: 'tok', transport: 'gateway', ice_servers: [], expires_at: 1767225600000 }), { status: 201 });
const NO_CREDIT = () => new Response(JSON.stringify({ message: 'Credit balance exhausted, please top up to continue.' }), { status: 402 });
const DOWN = () => new Response(JSON.stringify({ message: 'Internal server error' }), { status: 500 });

const realFetch = globalThis.fetch;
let retellReply, retell, mails;
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['sessions', 'activities', 'leads', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'call_link_%' OR key = 'voice_availability'").run();
  for (const [k, v] of [['voice_ai_api_key', KEY], ['voice_ai_agent_id', 'agent_test'], ['resend_api_key', 're_test_key_123']]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (1, 'hq', ?, 'x', 'superadmin', 'active', 'business')").run(FOUNDER_HQ_EMAIL);
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tenant', 't@example.com', 'x', 'user', 'active', 'business')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (10, 1, 'Hq Prospect', 'p@hq.example', 'Acme', 'new')").run();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('sess_hq', 1, datetime('now', '+1 day')), ('sess_tenant', 2, datetime('now', '+1 day'))").run();

  retellReply = OK; retell = []; mails = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.retellai.com/')) {
      retell.push({ url: u, body: JSON.parse(init.body || '{}') });
      return retellReply();
    }
    if (u.startsWith('https://api.resend.com/')) {
      mails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${mails.length}` }), { status: 200 });
    }
    if (u.includes('eiaawsolutions.com/llms.txt')) return new Response('', { status: 503 });
    return realFetch(url, init);
  };
});

async function server(fn) {
  const app = express();
  app.use('/api/voice/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (p, { method = 'GET', body, as } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (as) headers.authorization = `Bearer ${as}`;
    const r = await realFetch(base + p, { method, headers, body: body && JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const hook = async (payload) => {
    const body = JSON.stringify(payload);
    return realFetch(base + '/api/voice/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(KEY, body) }, body });
  };
  try { await fn({ call, hook }); } finally { s.close(); }
}

function link(leadId) {
  const t = `t${leadId}${Math.random().toString(16).slice(2)}`;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`call_link_${t}`, JSON.stringify({ leadId, userId: 1, expiresAt: new Date(Date.now() + 864e5).toISOString() }));
  return t;
}

async function waitFor(check, ms = 1500) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 10));
  }
  return true;
}

const WHY = /credit|retell|top.?up|budget/i;

test('a call Retell refuses for lack of credit pauses voice everywhere, without telling the visitor why', async () => {
  retellReply = NO_CREDIT;
  await server(async ({ call }) => {
    const res = await call(`/api/voice/call-link-token?t=${link(10)}`);
    assert.equal(res.status, 503);
    assert.equal(res.body.paused, true);
    assert.doesNotMatch(res.body.error, WHY);
    assert.deepEqual((await call('/api/voice/availability')).body, { available: false });
  });
  assert.equal(voiceAvailable(), false);
});

test('while voice is paused no call is created and no call link is handed out', async () => {
  pauseVoice('credit_exhausted');
  await server(async ({ call }) => {
    const res = await call(`/api/voice/call-link-token?t=${link(10)}`);
    assert.equal(res.status, 503);
    assert.equal(res.body.paused, true);
    const pub = await call('/api/voice/public-session', { method: 'POST', body: { source: 'eiaawsolutions.com' } });
    assert.equal(pub.status, 503);
    assert.equal(pub.body.paused, true);
    assert.equal(pub.body.callUrl, undefined);
  });
  assert.equal(retell.length, 0);
  // Only the link this test made; public-session made none.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'call_link_%'").get().n, 1);
});

test('a Retell outage that is not about credit leaves voice on', async () => {
  retellReply = DOWN;
  await server(async ({ call }) => {
    assert.equal((await call(`/api/voice/call-link-token?t=${link(10)}`)).status, 500);
    assert.deepEqual((await call('/api/voice/availability')).body, { available: true });
  });
});

test('a call cut off because credit ran out pauses voice; an ordinary hang-up does not', async () => {
  await server(async ({ hook }) => {
    await hook({ event: 'call_ended', call: { call_id: 'c1', disconnection_reason: 'user_hangup', metadata: {} } });
    assert.equal(voiceAvailable(), true);
    await hook({ event: 'call_ended', call: { call_id: 'c2', disconnection_reason: 'credit_exhausted', metadata: {} } });
    assert.equal(voiceAvailable(), false);
  });
});

test('the line check turns voice back on once Retell accepts a call, using a call that belongs to no lead', async () => {
  pauseVoice('credit_exhausted');
  await checkVoiceLine();
  assert.equal(voiceAvailable(), true);
  assert.equal(retell.length, 1);
  assert.equal(retell[0].url, 'https://api.retellai.com/v3/create-web-call');
  assert.equal(retell[0].body.agent_id, 'agent_test');
  assert.equal(retell[0].body.metadata.lead_id, undefined);
  assert.equal(retell[0].body.metadata.purpose, 'availability_check');
});

test('HQ is emailed once when voice pauses and once when it comes back, not on every failed check', async () => {
  retellReply = NO_CREDIT;
  await server(async ({ call }) => { await call(`/api/voice/call-link-token?t=${link(10)}`); });
  assert.ok(await waitFor(() => mails.length === 1), 'pause email');
  await checkVoiceLine();
  await checkVoiceLine();
  assert.equal(voiceAvailable(), false);

  retellReply = OK;
  await checkVoiceLine();
  assert.ok(await waitFor(() => mails.length === 2), 'resume email');
  assert.deepEqual(mails.map(m => [].concat(m.to)[0]), [FOUNDER_HQ_EMAIL, FOUNDER_HQ_EMAIL]);
  assert.match(mails[0].subject, /paused/i);
  assert.match(mails[0].html, /dashboard\.retellai\.com/);
  assert.match(mails[1].subject, /back on/i);
});

test('in the app, a customer is told voice is unavailable; HQ is told it is Retell credit', async () => {
  pauseVoice('credit_exhausted');
  await server(async ({ call }) => {
    const tenant = await call('/api/voice/web-call', { method: 'POST', body: {}, as: 'sess_tenant' });
    assert.equal(tenant.status, 503);
    assert.doesNotMatch(tenant.body.error, WHY);
    const hq = await call('/api/voice/web-call', { method: 'POST', body: {}, as: 'sess_hq' });
    assert.equal(hq.status, 503);
    assert.match(hq.body.error, /Retell/);
    assert.match(hq.body.error, /credit/i);
  });
  assert.equal(retell.length, 0);
});

test('the chatbot stops offering the voice agent while voice is paused', async () => {
  for (const origin of ['https://sa.eiaawsolutions.com', 'https://eiaawsolutions.com']) {
    const on = await buildChatbotPrompt(origin, '', { voiceAvailable: true });
    const off = await buildChatbotPrompt(origin, '', { voiceAvailable: false });
    assert.ok(off.startsWith(on), 'the paused note is appended, so the cached prefix is unchanged');
    assert.match(off.slice(on.length), /voice agent is unavailable/i);
  }
});

test('the availability answer is public, cached for a minute, and only says yes or no', async () => {
  await server(async ({ call }) => {
    const res = await call('/api/voice/availability');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { available: true });
    assert.match(res.headers.get('cache-control'), /max-age=60/);
  });
});
