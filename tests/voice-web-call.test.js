import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Retell turned off POST /v2/create-web-call on 18 Oct 2026; every call page
// showed "Deprecated API usage is no longer supported". v3 answers with a
// gateway transport the browser SDK must be told about — given only the
// token, SDK 3.x assumes LiveKit and the call never connects.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-webcall-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { default: voiceRouter } = await import('../src/routes/voice.js');
const { FOUNDER_HQ_EMAIL } = await import('../src/config/hq.js');

const ICE = [{ urls: ['turn:turn.example:3478'], username: 'u1', credential: 'turn-secret-1' }];
const realFetch = globalThis.fetch;
let retell = [];
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['sessions', 'activities', 'leads', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'call_link_%'").run();
  for (const [k, v] of [['voice_ai_api_key', 'key_test_retell_0123456789'], ['voice_ai_agent_id', 'agent_test']]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (1, 'hq', ?, 'x', 'superadmin', 'active', 'business')").run(FOUNDER_HQ_EMAIL);
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (10, 1, 'Hq Prospect', 'p@hq.example', 'Acme', 'new')").run();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('sess_hq', 1, datetime('now', '+1 day'))").run();

  retell = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.retellai.com/')) {
      retell.push({ url: u, body: JSON.parse(init.body) });
      if (u.endsWith('/v2/create-web-call')) {
        return new Response(JSON.stringify({ message: 'Deprecated API usage is no longer supported: Create Web Call v2.' }), { status: 400 });
      }
      return new Response(JSON.stringify({
        call_id: 'call_v3', access_token: 'tok_v3', transport: 'gateway', ice_servers: ICE, expires_at: 1767225600000,
      }), { status: 201 });
    }
    return realFetch(url, init);
  };
});

async function server(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer sess_hq' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(call); } finally { s.close(); }
}

function link(leadId) {
  const t = `t${leadId}${Math.random().toString(16).slice(2)}`;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`call_link_${t}`, JSON.stringify({ leadId, userId: 1, expiresAt: new Date(Date.now() + 864e5).toISOString() }));
  return t;
}

const CONNECT = { accessToken: 'tok_v3', callId: 'call_v3', transport: 'gateway', iceServers: ICE };

test('a call link creates a v3 web call and hands the browser everything startCall needs', async () => {
  await server(async (call) => {
    const res = await call(`/api/voice/call-link-token?t=${link(10)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual({ accessToken: res.body.accessToken, callId: res.body.callId, transport: res.body.transport, iceServers: res.body.iceServers }, CONNECT);
  });
  assert.equal(retell.length, 1);
  assert.equal(retell[0].url, 'https://api.retellai.com/v3/create-web-call');
  assert.equal(retell[0].body.agent_id, 'agent_test');
  assert.equal(retell[0].body.metadata.lead_id, '10');
});

test('a web call started from the app is created on v3 with the same connection details', async () => {
  await server(async (call) => {
    const res = await call('/api/voice/web-call', { method: 'POST', body: { leadId: 10 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual({ accessToken: res.body.accessToken, callId: res.body.callId, transport: res.body.transport, iceServers: res.body.iceServers }, CONNECT);
    assert.equal(res.body.agentId, 'agent_test');
  });
  assert.equal(retell[0].url, 'https://api.retellai.com/v3/create-web-call');
});

test("the lead's activity keeps the call id for the webhook, but not the call's credentials", async () => {
  await server(async (call) => {
    await call(`/api/voice/call-link-token?t=${link(10)}`);
    await call('/api/voice/web-call', { method: 'POST', body: { leadId: 10 } });
  });
  const outcomes = db.prepare("SELECT outcome FROM activities WHERE lead_id = 10 AND type = 'voice_call'").all().map(r => r.outcome);
  assert.equal(outcomes.length, 2);
  for (const o of outcomes) {
    assert.match(o, /call_v3/);
    assert.doesNotMatch(o, /tok_v3|turn-secret-1/);
  }
});
