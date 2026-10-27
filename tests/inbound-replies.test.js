import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Replies are read automatically: outreach goes out with a signed reply
// address, Resend posts each reply to the webhook, and the agent stops the
// sequence, labels the reply, takes the label's action, forwards it to the
// account's own inbox and drafts an answer for a person to approve. Only
// replies to our signed addresses are stored; a reply always stops the
// sequence, even if it cannot be labelled.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-inbound-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.OUTREACH_SEND_GAP_MS = '0';
process.env.INBOUND_REPLY_DOMAIN = 'inbound.example-resend.app';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
const SECRET = `whsec_${crypto.randomBytes(24).toString('base64')}`;
process.env.RESEND_WEBHOOK_SIGNING_SECRET = SECRET;

const { default: db } = await import('../src/db/index.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');
const { replyAddressFor, leadIdFromAddress } = await import('../src/services/reply-routing.js');
const { processInboundReplies, stripQuoted } = await import('../src/services/inbound-replies.js');
const { processOutreachQueue } = await import('../src/services/outreach-dispatch.js');
const { default: trackingRouter } = await import('../src/routes/tracking.js');
const { default: repliesRouter } = await import('../src/routes/replies.js');

const realFetch = globalThis.fetch;
let mails = [], received = {}, aiCalls = 0;
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['replies', 'pipeline', 'appointments', 'outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'email_suppressions', 'leads', 'campaigns', 'account_profiles', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `owner${id}@example.com`);
  }
  db.prepare(`INSERT INTO account_profiles (user_id, business_name, sender_name, offer, proof_points, reply_to_email, outreach_approval)
              VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes', 'HRD Corp claimable', 'aaron@tll.example', 0)`).run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, title, status, email_normalized) VALUES (20, 2, 'Daniel Lim', 'daniel@permata.example', 'Permata Utara Logistics', 'HR Director', 'contacted', 'daniel@permata.example')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status) VALUES (30, 3, 'Not Yours', 'n@other.example', 'Other', 'new')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status) VALUES (50, 2, 'C', 'email', 'active')").run();
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (50, 20, 'sent')").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, scheduled_at, user_id) VALUES (50, 20, 2, 'email', 'follow up', 'pending', datetime('now','+3 days'), 2)").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, scheduled_at, user_id) VALUES (50, 20, 3, 'email', 'last one', 'pending', datetime('now','+7 days'), 2)").run();
  mails = []; received = {}; aiCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = u.match(/^https:\/\/api\.resend\.com\/emails\/receiving\/(.+)$/);
    if (m) {
      const e = received[decodeURIComponent(m[1])];
      return e ? new Response(JSON.stringify(e)) : new Response('{}', { status: 404 });
    }
    if (u.startsWith('https://api.resend.com/')) {
      mails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${mails.length}` }));
    }
    return realFetch(url, init);
  };
  agent.resetChat();
});

function classifyAs(result) {
  agent.setChat(async (message, _x, opts) => {
    aiCalls++;
    if (opts?.useWebSearch) return JSON.stringify(result.__referral || { found: false });
    if (message.includes('"sequences"')) return JSON.stringify(result.__sequences || { sequences: [] });
    return JSON.stringify(result);
  });
}

function signed(body) {
  const id = `msg_${crypto.randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

function inbound(emailId, { to = replyAddressFor(20), text = 'Thanks.', headers = {}, subject = 'Re: your note' } = {}) {
  received[emailId] = { id: emailId, from: 'Daniel Lim <daniel@permata.example>', to: [to], subject, text, html: null, headers, message_id: `<${emailId}@mail.permata.example>` };
  return JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: emailId, from: 'daniel@permata.example', to: [to], subject, message_id: `<${emailId}@mail.permata.example>` } });
}

async function deliver(body) {
  const app = express();
  app.use('/api/tracking/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/api/tracking', trackingRouter);
  const s = app.listen(0);
  try {
    const r = await realFetch(`http://127.0.0.1:${s.address().port}/api/tracking/webhook`, { method: 'POST', body, headers: signed(body) });
    assert.equal(r.status, 200);
  } finally { s.close(); }
  await processInboundReplies();
}

const open = () => db.prepare("SELECT COUNT(*) c FROM outreach_queue WHERE lead_id = 20 AND status IN ('draft','pending')").get().c;
const reply = () => db.prepare('SELECT * FROM replies').get();

test('a reply address is signed for its lead and cannot be forged', () => {
  const a = replyAddressFor(20);
  assert.match(a, /^r-20-[0-9a-f]{16}@inbound\.example-resend\.app$/);
  assert.equal(leadIdFromAddress(`Reply <${a}>`), 20);
  const token = a.match(/-([0-9a-f]{16})@/)[1];
  const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  assert.equal(leadIdFromAddress(a.replace(token, flipped)), null, 'a tampered token is refused');
  assert.equal(leadIdFromAddress(a.replace('r-20-', 'r-30-')), null, 'another lead id with this token is refused');
  assert.equal(leadIdFromAddress(a.replace('inbound.example-resend.app', 'evil.example')), null);
});

test('outreach goes out with the lead\'s reply address', async () => {
  db.prepare("UPDATE outreach_queue SET scheduled_at = datetime('now','-1 minute') WHERE step = 2").run();
  await processOutreachQueue({ campaignId: 50 });
  assert.equal(mails[0].reply_to, replyAddressFor(20));
});

test('an interested reply is read, stops the sequence, qualifies the deal, is forwarded and gets a drafted answer', async () => {
  classifyAs({ intent: 'interested', confidence: 0.96, summary: 'Wants to meet Thursday', suggested_reply: { subject: 'Re: leaders', body: 'Hi Daniel, Thursday works.' } });
  await deliver(inbound('rcv_1', { text: 'Good timing. Free Thursday afternoon?\n\nOn Mon, 2 Nov 2026 Aaron wrote:\n> earlier email' }));
  const r = reply();
  assert.equal(r.status, 'new');
  assert.equal(r.intent, 'interested');
  assert.equal(r.body, 'Good timing. Free Thursday afternoon?', 'the quoted thread is dropped');
  assert.equal(open(), 0);
  assert.equal(db.prepare('SELECT stage FROM pipeline WHERE lead_id = 20').get().stage, 'qualification');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = 20').get().status, 'qualified');
  const actions = JSON.parse(r.actions);
  assert.ok(actions.some(a => /Stopped the sequence/.test(a)));
  assert.ok(actions.includes('Moved the deal to Qualified'));
  assert.equal(r.suggested_body, 'Hi Daniel, Thursday works.');
  const fwd = mails.find(m => m.to[0] === 'aaron@tll.example');
  assert.ok(fwd, 'forwarded to the account\'s inbox');
  assert.equal(fwd.reply_to, 'daniel@permata.example', 'answering from the inbox reaches the prospect');
  assert.match(fwd.html, /Interested/);
  assert.match(fwd.html, /Good timing/);
});

test('a webhook delivered twice is read and forwarded once', async () => {
  classifyAs({ intent: 'question', confidence: 0.9, summary: 'Asks about cost', suggested_reply: { subject: 'Re', body: 'Aaron will confirm.' } });
  const body = inbound('rcv_dup');
  await deliver(body);
  await deliver(body);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM replies').get().c, 1);
  assert.equal(mails.filter(m => m.to[0] === 'aaron@tll.example').length, 1);
});

test('mail to any address that is not one of our signed reply addresses is not stored', async () => {
  classifyAs({ intent: 'interested', confidence: 1, summary: 'x' });
  await deliver(inbound('rcv_x', { to: 'someone@inbound.example-resend.app' }));
  await deliver(inbound('rcv_y', { to: replyAddressFor(20).replace(/[0-9a-f]{16}@/, '0123456789abcdef@') }));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM replies').get().c, 0);
  assert.equal(open(), 2);
  assert.equal(aiCalls, 0);
});

test('an automatic away message changes nothing and costs no AI call', async () => {
  classifyAs({ intent: 'interested', confidence: 1, summary: 'x' });
  await deliver(inbound('rcv_ooo', { subject: 'Automatic reply: Re: your note', headers: { 'Auto-Submitted': 'auto-replied' }, text: 'I am away until 9 November.' }));
  assert.equal(open(), 2);
  assert.equal(reply().intent, 'out_of_office');
  assert.equal(reply().status, 'dismissed');
  assert.equal(aiCalls, 0);
});

test('a reply that cannot be labelled still stops the sequence and is still forwarded; labelling is retried', async () => {
  agent.setChat(async () => { throw new Error('overloaded'); });
  await deliver(inbound('rcv_fail', { text: 'Please call me.' }));
  assert.equal(open(), 0);
  assert.equal(reply().status, 'failed');
  assert.ok(mails.some(m => m.to[0] === 'aaron@tll.example'));
  assert.match(reply().actions, /Could not label it yet/);
});

test('"not now, try me in April" sets a reminder on that date and keeps the reason', async () => {
  const year = new Date().getUTCFullYear() + 1;
  classifyAs({ intent: 'not_now', confidence: 0.91, summary: 'Vendor list set; try in April', revisit_on: `${year}-04-01`, suggested_reply: { subject: 'Re', body: 'Understood — I will be in touch in April.' } });
  await deliver(inbound('rcv_nn', { text: 'Our vendor list is set. Try me again around April.' }));
  const appt = db.prepare("SELECT type, scheduled_at, title FROM appointments WHERE lead_id = 20").get();
  assert.equal(appt.type, 'follow_up');
  assert.equal(appt.scheduled_at, new Date(`${year}-04-01T09:00:00+08:00`).toISOString());
  assert.ok(JSON.parse(reply().actions).some(a => /Set a reminder for 1 April/.test(a)));
  assert.equal(open(), 0);
});

test('a verified referral becomes a lead with a drafted first email waiting for approval; nothing is guessed', async () => {
  classifyAs({
    intent: 'referral', confidence: 0.93, summary: 'Points to Farhana, the L&D manager', referral: { name: 'Farhana', role: 'L&D Manager' },
    suggested_reply: { subject: 'Re', body: 'Thank you, Daniel.' },
    __referral: { found: true, lead: { name: 'Farhana Aziz', title: 'L&D Manager', company: 'Permata Utara Logistics Sdn Bhd', email: 'farhana@permata.example', linkedin_url: 'https://www.linkedin.com/in/farhana-example', company_website: 'https://permata.example', verification_sources: ['https://permata.example/team'], confidence_score: 'High' } },
    __sequences: { sequences: [{ lead_name: 'Farhana Aziz', steps: [{ step: 1, channel: 'email', delay_days: 0, subject: 'Daniel suggested I write', message: 'Hi Farhana, Daniel suggested I get in touch. {{CALL_LINK}}', goal: 'open' }] }] },
  });
  await deliver(inbound('rcv_ref', { text: 'Training sits with our L&D manager, Farhana. Please speak to her.' }));
  const farhana = db.prepare("SELECT * FROM leads WHERE email_normalized = 'farhana@permata.example'").get();
  assert.ok(farhana, 'created');
  assert.equal(farhana.user_id, 2);
  assert.equal(farhana.source, 'referral');
  assert.match(farhana.notes, /^Referral: Daniel Lim/);
  const draft = db.prepare('SELECT status, message FROM outreach_queue WHERE lead_id = ?').get(farhana.id);
  assert.equal(draft.status, 'draft', 'waits for approval even though this account sends without approval');
  const actions = JSON.parse(reply().actions);
  assert.ok(actions.some(a => /verified their role/.test(a)));
  assert.ok(actions.some(a => /Created a new lead and noted the referral from Daniel Lim/.test(a)));
  assert.ok(actions.some(a => /Drafted a first email that mentions Daniel Lim's referral/.test(a)));
});

test('a referral that cannot be verified creates no lead — only a task to find them', async () => {
  classifyAs({
    intent: 'referral', confidence: 0.9, summary: 'Points to Farhana', referral: { name: 'Farhana', role: '' },
    __referral: { found: true, lead: { name: 'Farhana', company: 'Permata Utara', email: 'hr@permata.example', company_website: 'https://permata.example', verification_sources: ['https://permata.example'], confidence_score: 'High' } },
  });
  await deliver(inbound('rcv_ref2', { text: 'Speak to Farhana.' }));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads WHERE user_id = 2").get().c, 1);
  assert.ok(JSON.parse(reply().actions).some(a => /Could not verify Farhana/.test(a)));
  assert.match(db.prepare("SELECT description FROM activities WHERE type = 'task'").get().description, /Referred to Farhana/);
});

async function inbox(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business' }; next(); });
  app.use('/api/replies', repliesRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, p, body) => { const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try { await fn(call); } finally { s.close(); }
}

test('the Replies inbox shows the account\'s replies only, and an approved answer threads under the reply', async () => {
  classifyAs({ intent: 'interested', confidence: 0.96, summary: 'Wants to meet', suggested_reply: { subject: 'Re: leaders', body: 'Thursday works.' } });
  await deliver(inbound('rcv_inbox', { text: 'Can we talk Thursday?' }));
  const id = reply().id;
  mails = [];
  await inbox(3, async (call) => {
    assert.deepEqual((await call('GET', '/api/replies')).body.replies, []);
    assert.equal((await call('POST', `/api/replies/${id}/send`, { subject: 'x', body: 'y' })).status, 404);
  });
  await inbox(2, async (call) => {
    const list = (await call('GET', '/api/replies?status=open')).body;
    assert.equal(list.automatic, true);
    assert.equal(list.replies.length, 1);
    assert.equal(list.replies[0].lead_name, 'Daniel Lim');
    assert.equal((await call('GET', '/api/replies/count')).body.open, 1);
    const sent = await call('POST', `/api/replies/${id}/send`, { subject: 'Re: leaders', body: 'Thursday 3pm works.' });
    assert.equal(sent.status, 200);
    assert.equal((await call('GET', '/api/replies/count')).body.open, 0);
  });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to[0], 'daniel@permata.example');
  assert.equal(mails[0].headers['In-Reply-To'], '<rcv_inbox@mail.permata.example>');
  assert.equal(mails[0].reply_to, replyAddressFor(20), 'their next reply is read too');
  assert.equal(reply().status, 'answered');
});

test('quoted history is cut in the usual formats', () => {
  assert.equal(stripQuoted('Yes please.\n\n-----Original Message-----\nFrom: Aaron'), 'Yes please.');
  assert.equal(stripQuoted('Boleh.\nPada Isn, 2 Nov 2026 Aaron menulis:\n> hi'), 'Boleh.');
  assert.equal(stripQuoted('Sure\n\nFrom: Aaron Joseph <aaron@tll.example>\nSent: Monday'), 'Sure');
});
