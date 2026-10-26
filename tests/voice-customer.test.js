import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// A customer's prospect who clicks the voice link talks to the customer's
// assistant — about the customer's offer — and a booked meeting is a real
// meeting with the customer's host, not a demo of EIAAW with a made-up link.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-voicecust-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { default: voiceRouter, SALES_AGENT_PROMPT } = await import('../src/routes/voice.js');
const { default: appointmentsRouter } = await import('../src/routes/appointments.js');
const { signRetell } = await import('../src/services/ingest-auth.js');
const { FOUNDER_HQ_EMAIL } = await import('../src/config/hq.js');

const KEY = 'key_test_retell_0123456789';
const realFetch = globalThis.fetch;
let retellCalls = [];
let mails = [];
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

function reset({ brief = true, meetingLink = 'https://meet.google.com/tll-room-abc' } = {}) {
  for (const t of ['appointments', 'activities', 'leads', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'call_link_%'").run();
  for (const [k, v] of [['voice_ai_api_key', KEY], ['voice_ai_agent_id', 'agent_test'], ['resend_api_key', 're_test_key_123']]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (1, 'hq', ?, 'x', 'superadmin', 'active', 'business')`).run(FOUNDER_HQ_EMAIL);
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')`).run();
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (3, 'other', 'other@example.com', 'x', 'user', 'active', 'business')`).run();
  if (brief) {
    db.prepare(`INSERT INTO account_profiles (user_id, business_name, sender_name, offer, proof_points, call_to_action, voice_notes, reply_to_email, meeting_link)
                VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes for first-time managers', 'HRD Corp claimable', 'a 20-minute call', 'Cohorts of 12 to 20', 'aaron@tll.example', ?)`).run(meetingLink);
  }
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (20, 2, 'Grace Tan Mei Ling', 'grace@lumina.example', 'Lumina Medika', 'new')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (10, 1, 'Hq Prospect', 'p@hq.example', 'Acme', 'new')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (30, 3, 'Not Yours', 'n@other.example', 'Other', 'new')").run();

  retellCalls = []; mails = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.retellai.com/')) {
      retellCalls.push({ url: u, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ access_token: 'tok', call_id: `call_${retellCalls.length}`, agent_id: 'agent_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.resend.com/')) {
      mails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${mails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
}
beforeEach(() => reset());

function link(leadId, userId) {
  const t = `t${leadId}${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(`call_link_${t}`, JSON.stringify({ leadId, userId, expiresAt: new Date(Date.now() + 864e5).toISOString() }));
  return t;
}

async function server(fn, userId = 2) {
  const app = express();
  app.use(['/api/voice/webhook', '/api/voice/tool-callback'], express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  app.use('/api/appointments', appointmentsRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };
  const tool = async (payload) => {
    const body = JSON.stringify(payload);
    const r = await realFetch(base + '/api/voice/tool-callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(KEY, body) }, body });
    return { status: r.status, body: await r.json() };
  };
  const hook = async (payload) => {
    const body = JSON.stringify(payload);
    return realFetch(base + '/api/voice/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(KEY, body) }, body });
  };
  try { await fn({ get, tool, hook, base }); } finally { s.close(); }
}

test("a customer's prospect is greeted by the customer's assistant, not EIAAW's", async () => {
  await server(async ({ get }) => {
    const res = await get(`/api/voice/call-link-token?t=${link(20, 2)}`);
    assert.equal(res.status, 200);
  });
  const vars = retellCalls[0].body.retell_llm_dynamic_variables;
  assert.equal(vars.site_scope, 'customer_lead');
  assert.equal(vars.business_name, 'The Leadership Lab');
  assert.equal(vars.sender_name, 'Aaron Joseph');
  assert.match(vars.begin_message, /AI assistant for The Leadership Lab/);
  assert.doesNotMatch(vars.begin_message, /E-I-A-A-W|EIAAW/);
  assert.equal(retellCalls[0].body.metadata.lead_id, '20');
});

test("the call page can name the customer's business before any call is created", async () => {
  await server(async ({ get }) => {
    const cust = await get(`/api/voice/call-link-info?t=${link(20, 2)}`);
    assert.deepEqual(cust.body, { businessName: 'The Leadership Lab' });
    const own = await get(`/api/voice/call-link-info?t=${link(10, 1)}`);
    assert.deepEqual(own.body, { businessName: null });
    assert.equal((await get('/api/voice/call-link-info?t=nope')).status, 404);
  });
  assert.equal(retellCalls.length, 0);
});

test('EIAAW\'s own leads keep the EIAAW persona, with every customer variable present but empty', async () => {
  await server(async ({ get }) => { await get(`/api/voice/call-link-token?t=${link(10, 1)}`); });
  const vars = retellCalls[0].body.retell_llm_dynamic_variables;
  assert.equal(vars.site_scope, 'lead');
  assert.equal(vars.business_name, '');
  assert.equal(vars.voice_notes, '');
});

test('a customer with no brief, or over their monthly voice allowance, gets no call created', async () => {
  reset({ brief: false });
  await server(async ({ get }) => {
    const res = await get(`/api/voice/call-link-token?t=${link(20, 2)}`);
    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /EIAAW|E-I-A-A-W/);
  });
  reset();
  const ins = db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (2, 20, 'voice_call', 'x')");
  for (let i = 0; i < 100; i++) ins.run();
  await server(async ({ get }) => {
    assert.equal((await get(`/api/voice/call-link-token?t=${link(20, 2)}`)).status, 429);
  });
  assert.equal(retellCalls.length, 0);
});

test("a booking is a real meeting with the customer's host: their room, their name, an invite to both", async () => {
  await server(async ({ tool }) => {
    const r = await tool({ name: 'schedule_meeting', args: { date_time: 'Thursday at 3pm', duration: '30', meeting_type: 'meeting', notes: 'Need: 40 nurses; Budget: 2027 line; Authority: CHRO signs; Timeline: Feb' }, call: { call_id: 'c1', metadata: { lead_id: '20' } } });
    assert.equal(r.status, 200);
  });
  await new Promise(r => setTimeout(r, 50));
  const appt = db.prepare('SELECT user_id, location, title FROM appointments').get();
  assert.equal(appt.user_id, 2);
  assert.equal(appt.location, 'https://meet.google.com/tll-room-abc');
  const toLead = mails.find(m => m.to[0] === 'grace@lumina.example');
  const toHost = mails.find(m => m.to[0] === 'aaron@tll.example');
  assert.ok(toLead && toHost, 'invite to the prospect and a copy to the host');
  assert.equal(toLead.from, '"Aaron Joseph (The Leadership Lab)" <sales@eiaawsolutions.com>');
  assert.equal(toLead.reply_to, 'aaron@tll.example');
  assert.match(toLead.html, /The Leadership Lab/);
  assert.doesNotMatch(toLead.html, /EIAAW/);
  const ics = Buffer.from(toLead.attachments[0].content, 'base64').toString();
  assert.match(ics, /ORGANIZER;CN=Aaron Joseph:mailto:aaron@tll\.example/);
  assert.match(ics, /ATTENDEE;CN=Aaron Joseph;ROLE=CHAIR:mailto:aaron@tll\.example/);
  assert.match(ics, /ATTENDEE;CN=Grace Tan Mei Ling;RSVP=TRUE:mailto:grace@lumina\.example/);
  assert.match(ics, /LOCATION:https:\/\/meet\.google\.com\/tll-room-abc/);
  // The assistant's qualification notes are for the host, never the prospect.
  assert.doesNotMatch(toLead.html + ics, /Budget|CHRO/);
  assert.match(toHost.html, /Need: 40 nurses; Budget: 2027 line/);
});

test('calendar text is escaped so a comma, semicolon or newline cannot break the event', async () => {
  const { generateICS } = await import('../src/routes/appointments.js');
  const now = new Date();
  const ics = generateICS({ id: 1, scheduled: now, end: now, title: 'Call; with A, B\nX', host: { name: 'A;B', email: 'a@b.example' } });
  assert.match(ics, /SUMMARY:Call\\; with A\\, B\\nX/);
  assert.match(ics, /ORGANIZER;CN=A B:mailto:a@b\.example/);
});

test('with no meeting link on file, no fake Meet link is invented', async () => {
  reset({ meetingLink: null });
  await server(async ({ tool }) => {
    await tool({ name: 'schedule_meeting', args: { date_time: 'Thursday at 3pm' }, call: { call_id: 'c2', metadata: { lead_id: '20' } } });
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(db.prepare('SELECT location FROM appointments').get().location, null);
  assert.ok(mails.every(m => !/meet\.google\.com/.test(m.html)));
  assert.match(mails.find(m => m.to[0] === 'grace@lumina.example').html, /Aaron Joseph will send the joining link/);
});

test("on a customer's call, 'send me info' sends the customer's overview and the EIAAW demo link is refused", async () => {
  await server(async ({ tool }) => {
    await tool({ name: 'send_overview', args: {}, call: { call_id: 'c3', metadata: { lead_id: '20' } } });
    const demo = await tool({ name: 'send_demo_link', args: {}, call: { call_id: 'c3', metadata: { lead_id: '20' } } });
    assert.doesNotMatch(demo.body.result, /sent/i);
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(mails.length, 1);
  assert.match(mails[0].html, /Leadership programmes for first-time managers/);
  assert.doesNotMatch(mails[0].html + mails[0].subject, /EIAAW/);
});

test('a call summary that mentions a meeting no longer invents an appointment time', async () => {
  await server(async ({ hook }) => {
    await hook({ event: 'call_analyzed', call: { call_id: 'c9', metadata: { lead_id: '20' }, call_analysis: { call_summary: 'Meeting booked for next week', user_sentiment: 'Positive' } } });
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM appointments').get().c, 0);
  assert.match(db.prepare("SELECT description FROM activities WHERE lead_id = 20 ORDER BY id DESC").get().description, /no time was booked/i);
});

test('a meeting cannot be created against another account\'s lead', async () => {
  db.prepare("INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES ('sess2', 2, datetime('now', '+1 day'))").run();
  await server(async ({ base }) => {
    const r = await realFetch(base + '/api/appointments', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sess2' }, body: JSON.stringify({ lead_id: 30, title: 't', scheduled_at: new Date(Date.now() + 864e5).toISOString() }) });
    assert.equal(r.status, 404);
  });
  assert.equal(mails.length, 0);
});

test('the voice prompt has a customer mode and never tells the agent to hide that it is an AI', () => {
  assert.match(SALES_AGENT_PROMPT, /CUSTOMER LEAD MODE — when \{\{site_scope\}\} = "customer_lead"/);
  assert.match(SALES_AGENT_PROMPT, /\{\{business_name\}\}/);
  assert.doesNotMatch(SALES_AGENT_PROMPT, /Never volunteer that you're AI/);
});
