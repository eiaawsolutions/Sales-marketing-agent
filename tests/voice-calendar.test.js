import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// With a booking calendar on the Brief, the voice assistant offers times that
// are really free, books only a free time, and books it on the host's own
// calendar (which confirms to the prospect itself). If the calendar cannot be
// read the meeting is still booked here, and the host is asked to confirm.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-voicecal-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { default: voiceRouter } = await import('../src/routes/voice.js');
const { signRetell } = await import('../src/services/ingest-auth.js');
const { __testing: cal } = await import('../src/services/calendar.js');

const KEY = 'key_test_retell_0123456789';
const realFetch = globalThis.fetch;
let retell = [], mails = [], bookings = [], calcomDown = false;
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

// Free slots two and three days out, 15:00 and 10:00 MYT.
const dayOut = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const FREE = [`${dayOut(2)}T07:00:00.000Z`, `${dayOut(3)}T02:00:00.000Z`];

beforeEach(() => {
  for (const t of ['appointments', 'activities', 'leads', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'call_link_%'").run();
  for (const [k, v] of [['voice_ai_api_key', KEY], ['voice_ai_agent_id', 'agent_test'], ['resend_api_key', 're_test_key_123']]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')").run();
  db.prepare(`INSERT INTO account_profiles (user_id, business_name, sender_name, offer, reply_to_email, booking_link)
              VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes', 'aaron@tll.example', 'https://cal.com/aaron-tll/30min')`).run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (20, 2, 'Grace Tan', 'grace@lumina.example', 'Lumina Medika', 'contacted')").run();
  retell = []; mails = []; bookings = []; calcomDown = false;
  cal.clearCache();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.cal.com/v2/slots')) {
      if (calcomDown) return new Response('{}', { status: 503 });
      const data = {};
      for (const s of FREE) (data[s.slice(0, 10)] ||= []).push({ start: s });
      return new Response(JSON.stringify({ status: 'success', data }));
    }
    if (u === 'https://api.cal.com/v2/bookings') {
      bookings.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ status: 'success', data: { uid: 'bk_1', location: 'https://cal.com/video/room1' } }), { status: 201 });
    }
    if (u.startsWith('https://api.retellai.com/')) {
      retell.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ access_token: 'tok', call_id: 'call_1' }));
    }
    if (u.startsWith('https://api.resend.com/')) {
      mails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${mails.length}` }));
    }
    return realFetch(url, init);
  };
});

async function server(fn) {
  const app = express();
  app.use(['/api/voice/webhook', '/api/voice/tool-callback'], express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };
  const tool = async (payload) => {
    const body = JSON.stringify(payload);
    const r = await realFetch(base + '/api/voice/tool-callback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-retell-signature': signRetell(KEY, body) }, body });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ get, tool }); } finally { s.close(); }
}

const book = (date_time, call_id = 'c1') => ({ name: 'schedule_meeting', args: { date_time, duration: '30', meeting_type: 'meeting', notes: 'Need: 40 nurses' }, call: { call_id, metadata: { lead_id: '20' } } });
const flush = () => new Promise(r => setTimeout(r, 30));

test('a call from the voice link carries two free times from the calendar', async () => {
  const t = 'tcal' + Math.random().toString(16).slice(2);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`call_link_${t}`, JSON.stringify({ leadId: 20, userId: 2, expiresAt: new Date(Date.now() + 864e5).toISOString() }));
  await server(async ({ get }) => { assert.equal((await get(`/api/voice/call-link-token?t=${t}`)).status, 200); });
  const vars = retell[0].retell_llm_dynamic_variables;
  assert.equal(vars.calendar_connected, 'yes');
  assert.match(vars.available_times, /, or .*Malaysia time$/);
  for (const s of FREE) assert.ok(vars.available_slot_codes.includes(s));
});

test('a free time is booked on the host\'s calendar; the calendar confirms to the prospect, the host gets the notes', async () => {
  await server(async ({ tool }) => {
    const r = await tool(book(FREE[0]));
    assert.match(r.body.result, /^Booked for/);
  });
  await flush();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].start, FREE[0]);
  assert.equal(bookings[0].attendee.email, 'grace@lumina.example');
  const appt = db.prepare('SELECT location, status FROM appointments').get();
  assert.equal(appt.location, 'https://cal.com/video/room1');
  assert.ok(mails.every(m => m.to[0] !== 'grace@lumina.example'), 'no second invite from us');
  const hostCopy = mails.find(m => m.to[0] === 'aaron@tll.example');
  assert.match(hostCopy.html, /Need: 40 nurses/);
  assert.match(hostCopy.html, /on your Cal\.com calendar/);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = 20').get().status, 'qualified');
});

test('a time that is not free is not booked; the nearest free times are offered instead', async () => {
  const busy = new Date(new Date(FREE[0]).getTime() + 3600000).toISOString();
  await server(async ({ tool }) => {
    const r = await tool(book(busy));
    assert.match(r.body.result, /isn't free/);
    assert.ok(r.body.result.includes(FREE[0]), 'gives the exact time to book');
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM appointments').get().c, 0);
  assert.equal(bookings.length, 0);
});

test('if the calendar cannot be read, nothing is booked or confirmed — the host is asked to confirm the time', async () => {
  calcomDown = true;
  await server(async ({ tool }) => {
    const r = await tool(book(FREE[0]));
    assert.match(r.body.result, /can't confirm/i);
    assert.doesNotMatch(r.body.result, /^Booked/);
  });
  await flush();
  assert.equal(bookings.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM appointments').get().c, 0);
  assert.ok(mails.every(m => m.to[0] !== 'grace@lumina.example'), 'no confirmation to the prospect');
  assert.match(db.prepare("SELECT description FROM activities WHERE type = 'task'").get().description, /confirm/);
});

test('what the call captured — Need, Budget, Authority, Timeline — stays on the lead and the lead is re-scored', async () => {
  const { __testing: agent } = await import('../src/services/ai-agent.js');
  const f = (score, note) => ({ score, note });
  agent.setChat(async () => JSON.stringify({ bant: { budget: f(22, 'Leadership line in 2027 plan'), authority: f(21, 'CHRO signs above threshold'), need: f(24, '40 nurses to unit managers'), timeline: f(22, 'Feb–Mar 2027') }, reasoning: 'Call confirmed every factor.', recommended_action: 'Prepare outline and cost per participant.' }));
  db.prepare('UPDATE leads SET score = 81 WHERE id = 20').run();
  await server(async ({ tool }) => {
    await tool({ name: 'log_call_outcome', args: { interest_level: 'hot', summary: 'Need: about 40 senior nurses moving into unit-manager roles; Budget: leadership line in the 2027 plan, HRD Corp claims; Authority: Grace leads, CHRO signs off above a threshold; Timeline: first cohort Feb–Mar 2027', next_step: 'Meeting booked' }, call: { call_id: 'c9', metadata: { lead_id: '20' } } });
  });
  await new Promise(r => setTimeout(r, 50));
  const lead = db.prepare('SELECT score, score_detail FROM leads WHERE id = 20').get();
  const detail = JSON.parse(lead.score_detail);
  assert.equal(detail.call.need, 'about 40 senior nurses moving into unit-manager roles');
  assert.equal(detail.call.timeline, 'first cohort Feb–Mar 2027');
  assert.equal(lead.score, 89, 're-scored from the call');
  assert.match(db.prepare("SELECT description FROM activities WHERE type = 'note'").get().description, /^What the call captured — Need: about 40/);
  agent.resetChat();
});

test('a meeting the assistant only mentions in its notes is not booked unchecked when a calendar is connected', async () => {
  await server(async ({ tool }) => {
    await tool({ name: 'log_call_outcome', args: { interest_level: 'hot', summary: 'Need: unknown; Budget: unknown; Authority: unknown; Timeline: unknown', next_step: 'meet', meeting_requested: true, meeting_time: 'Thursday at 3pm' }, call: { call_id: 'c10', metadata: { lead_id: '20' } } });
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM appointments').get().c, 0);
  assert.match(db.prepare("SELECT description FROM activities WHERE type = 'task'").get().description, /not booked/);
  assert.equal(db.prepare('SELECT score_detail FROM leads WHERE id = 20').get().score_detail, null, '"unknown" captures nothing');
});
