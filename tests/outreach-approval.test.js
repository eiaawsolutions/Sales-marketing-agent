import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Outreach is drafted by the agent, approved by a person, then sent on
// schedule — and the first email really goes out (it used to be marked "sent"
// without ever being handed to the mail provider).
const dir = mkdtempSync(path.join(tmpdir(), 'sa-approval-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.OUTREACH_SEND_GAP_MS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { processOutreachQueue } = await import('../src/services/outreach-dispatch.js');
const { suppress } = await import('../src/services/unsubscribe.js');
const { default: campaignsRouter } = await import('../src/routes/campaigns.js');

const realFetch = globalThis.fetch;
let sent = [];
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

function reset({ approval = 1 } = {}) {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'email_suppressions', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  for (const id of [2, 3]) {
    db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')`)
      .run(id, `u${id}`, `owner${id}@example.com`);
  }
  db.prepare("INSERT INTO account_profiles (user_id, business_name, offer, outreach_approval) VALUES (2, 'The Leadership Lab', 'Leadership programmes', ?)").run(approval);
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (20, 2, 'Lee Shu Fen', 'shufen@velora.example', 'Velora')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (21, 2, 'Nurul Huda', 'nurul@seri.example', 'Seri Andalas')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (50, 2, 'TLL Q4', 'email', 'active', 'Hi', '<p>x</p>')").run();
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, 20), (50, 21)").run();

  sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  agent.setChat(async () => JSON.stringify({ sequences: ['Lee Shu Fen', 'Nurul Huda'].map(name => ({
    lead_name: name,
    steps: [
      { step: 1, channel: 'email', delay_days: 0, subject: `First note for ${name}`, message: 'Hello {{CALL_LINK}}', goal: 'open' },
      { step: 2, channel: 'email', delay_days: 3, subject: `Follow-up for ${name}`, message: 'Following up {{CALL_LINK}}', goal: 'nudge' },
      { step: 3, channel: 'email', delay_days: 7, subject: `Last note for ${name}`, message: 'Last one {{CALL_LINK}}', goal: 'close' },
    ],
  })) }));
}
beforeEach(() => reset());

const statuses = () => db.prepare('SELECT status, COUNT(*) c FROM outreach_queue GROUP BY status').all()
  .reduce((o, r) => ({ ...o, [r.status]: r.c }), {});

test('with approval on, the agent only drafts: nothing is sent and no lead is marked sent', async () => {
  const res = await runAgent(2, 'auto_outreach', { campaignId: 50 });
  assert.equal(res.drafted, 6);
  await processOutreachQueue();
  assert.equal(sent.length, 0);
  assert.deepEqual(statuses(), { draft: 6 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM campaign_leads WHERE status <> 'pending'").get().c, 0);
});

test('approving re-bases the schedule on the approval time and Day 0 actually sends', async () => {
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  db.prepare("UPDATE outreach_queue SET created_at = datetime('now', '-5 days'), scheduled_at = datetime('now', '-5 days')").run();
  await withRoutes(2, async (call) => {
    const res = await call('POST', '/api/campaigns/50/outreach/approve', { leadIds: [20] });
    assert.equal(res.status, 200);
    assert.equal(res.body.approved, 3);
  });
  const step2 = db.prepare("SELECT scheduled_at > datetime('now', '+2 days') AS later FROM outreach_queue WHERE lead_id = 20 AND step = 2").get();
  assert.equal(step2.later, 1, 'a 5-day-old draft must not fire its Day-3 step the moment it is approved');

  await processOutreachQueue();
  assert.deepEqual(sent.map(m => m.subject), ['First note for Lee Shu Fen']);
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE lead_id = 20').get().status, 'sent');
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE lead_id = 21').get().status, 'pending');
  const row = db.prepare('SELECT status, provider_message_id FROM outreach_queue WHERE lead_id = 20 AND step = 1').get();
  assert.deepEqual(row, { status: 'sent', provider_message_id: 're_1' });
});

test('with approval off, Day 0 goes out straight away — exactly once even with two dispatchers', async () => {
  reset({ approval: 0 });
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  await Promise.all([processOutreachQueue(), processOutreachQueue()]);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(m => m.subject).sort(), ['First note for Lee Shu Fen', 'First note for Nurul Huda']);
  assert.equal(statuses().sent, 2);
  assert.equal(statuses().pending, 4);
});

test('a draft can be edited before approval, never after it is sent', async () => {
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const item = db.prepare('SELECT id FROM outreach_queue WHERE lead_id = 20 AND step = 1').get();
  await withRoutes(2, async (call) => {
    assert.equal((await call('PUT', `/api/campaigns/50/outreach/${item.id}`, { subject: 'Edited', message: '<p>Edited body</p>' })).status, 200);
    await call('POST', '/api/campaigns/50/outreach/approve', { itemIds: [item.id] });
    await processOutreachQueue();
    assert.equal((await call('PUT', `/api/campaigns/50/outreach/${item.id}`, { subject: 'Too late' })).status, 409);
  });
  assert.equal(sent[0].subject, 'Edited');
});

test('skipping a lead cancels its drafts; another account cannot touch the queue', async () => {
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  await withRoutes(3, async (call) => {
    assert.equal((await call('POST', '/api/campaigns/50/outreach/approve', {})).status, 404);
  });
  await withRoutes(2, async (call) => {
    assert.equal((await call('POST', '/api/campaigns/50/outreach/skip', { leadIds: [21] })).status, 200);
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM outreach_queue WHERE lead_id = 21 AND status = 'skipped'").get().c, 3);
  assert.equal(statuses().draft, 3);
});

test('stopping a campaign or suppressing a contact cancels drafts as well as scheduled sends', async () => {
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  suppress({ userId: 2, email: 'nurul@seri.example', reason: 'unsubscribe', leadId: 21 });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM outreach_queue WHERE lead_id = 21 AND status <> 'skipped'").get().c, 0);
  await withRoutes(2, async (call) => {
    assert.equal((await call('PATCH', '/api/campaigns/50/status', { status: 'stopped', confirm: 'STOP' })).status, 200);
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM outreach_queue WHERE status IN ('draft','pending')").get().c, 0);
});

test("outreach goes out under the account's name, with replies to the account's inbox", async () => {
  reset({ approval: 0 });
  db.prepare("UPDATE account_profiles SET sender_name = 'Aaron Joseph', business_name = 'The Leadership Lab', reply_to_email = 'aaron@tll.example' WHERE user_id = 2").run();
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  await processOutreachQueue();
  assert.equal(sent[0].from, '"Aaron Joseph (The Leadership Lab)" <sales@eiaawsolutions.com>');
  assert.equal(sent[0].reply_to, 'aaron@tll.example');
});

test("the account's own address is used only once its domain is verified for sending", async () => {
  reset({ approval: 0 });
  db.prepare("UPDATE account_profiles SET sender_name = 'Aaron Joseph', from_email = 'aaron@tll.example' WHERE user_id = 2").run();
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  await processOutreachQueue();
  assert.match(sent[0].from, /<sales@eiaawsolutions\.com>$/, 'unverified domain: EIAAW address, customer name');
  assert.equal(sent[0].reply_to, 'owner2@example.com', 'no reply-to set: replies go to the account owner, not EIAAW');

  reset({ approval: 0 });
  db.prepare("UPDATE account_profiles SET sender_name = 'Aaron Joseph', from_email = 'aaron@tll.example' WHERE user_id = 2").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('verified_sender_domains', 'tll.example')").run();
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  await processOutreachQueue();
  db.prepare("DELETE FROM settings WHERE key = 'verified_sender_domains'").run();
  assert.equal(sent[0].from, '"Aaron Joseph (The Leadership Lab)" <aaron@tll.example>');
});

test('plain-text drafts keep their line breaks and clickable links; HTML is escaped', async () => {
  reset({ approval: 0 });
  agent.setChat(async () => JSON.stringify({ sequences: [{ lead_name: 'Lee Shu Fen', steps: [
    { step: 1, channel: 'email', delay_days: 0, subject: 's', message: 'Hi Shu Fen,\n\nSee <b>this</b>: {{CALL_LINK}}\n\nAaron', goal: 'g' },
  ] }] }));
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  await processOutreachQueue();
  const html = sent[0].html;
  assert.match(html, /Hi Shu Fen,<br>/);
  assert.match(html, /&lt;b&gt;this&lt;\/b&gt;/, 'model-written markup is shown, not rendered');
  assert.match(html, /<a href="https:\/\/sa\.eiaawsolutions\.com\/api\/tracking\/click\/50\/20\?t=[0-9a-f]+&url=https%3A%2F%2Fsa\.eiaawsolutions\.com%2Fcall\.html/);
});

test('a sender name cannot inject headers or a second address', async () => {
  const { safeDisplayName } = await import('../src/utils/email.js');
  assert.equal(safeDisplayName('Evil\r\nBcc: x@y.z'), 'Evil Bcc: x@y.z');
  assert.equal(safeDisplayName('A "B" <c@d.e>'), 'A B c@d.e');
});

async function withRoutes(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business', email: `owner${userId}@example.com` }; next(); });
  app.use('/api/campaigns', campaignsRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await realFetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  try { await fn(call); } finally { server.close(); }
}
