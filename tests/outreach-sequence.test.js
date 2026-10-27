import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// A sequence is a first email on day 0, a LinkedIn connection note on day 1
// that the team sends from their own account, and follow-up emails on days 3
// and 7. Every email carries the voice link; the LinkedIn note never does and
// is never sent by the platform. Each draft records which phrases came from
// the lead's public signals and which from the brief, so a person can see
// what was personalised. Drafts can be rewritten shorter or longer before
// approval without losing the voice link.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-seq-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.OUTREACH_SEND_GAP_MS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { processOutreachQueue } = await import('../src/services/outreach-dispatch.js');
const { approveDrafts } = await import('../src/services/outreach-queue.js');
const { default: campaignsRouter } = await import('../src/routes/campaigns.js');

const realFetch = globalThis.fetch;
let sent = [];
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const LONG_NOTE = 'Hi Shu Fen, I work with HR and L&D leaders on first-time managers. Saw the second Kulim plant and would like to connect. '.repeat(4);

function sequenceReply({ linkedinFor = ['Lee Shu Fen', 'Nurul Huda'], note = 'Hi Shu Fen, saw the second Kulim plant — would like to connect. Aaron' } = {}) {
  return JSON.stringify({ sequences: ['Lee Shu Fen', 'Nurul Huda'].map(name => ({
    lead_name: name,
    steps: [
      { step: 1, channel: 'email', delay_days: 0, subject: 'The second Kulim plant', message: 'Hi, congratulations on the second Kulim plant. We run leadership programmes for first-time managers. {{CALL_LINK}} Aaron', goal: 'open',
        personalised: ['the second Kulim plant', 'a phrase that is not in the message'], from_brief: ['leadership programmes for first-time managers'] },
      ...(linkedinFor.includes(name) ? [{ step: 2, channel: 'linkedin', delay_days: 1, message: note, goal: 'connect', personalised: ['second Kulim plant'] }] : []),
      { step: 3, channel: 'email', delay_days: 3, subject: 'A checklist', message: 'Following up. {{CALL_LINK}}', goal: 'nudge' },
      { step: 4, channel: 'email', delay_days: 7, subject: 'Talk any time', message: 'Last note — our AI assistant can answer any time: {{CALL_LINK}}', goal: 'close' },
    ],
  })) });
}

beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `o${id}@example.com`);
  }
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer, proof_points) VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes for first-time managers', 'HRD Corp claimable')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, notes) VALUES (20, 2, 'Lee Shu Fen', 'shufen@velora.example', 'Velora', 'Buying signal: second Kulim plant\nProfile: https://www.linkedin.com/in/shufen-example')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, notes) VALUES (21, 2, 'Nurul Huda', 'nurul@seri.example', 'Seri Andalas', 'Website: https://seri.example')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject) VALUES (50, 2, 'TLL Q4', 'email', 'active', 'Hi')").run();
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, 20), (50, 21)').run();
  sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  agent.resetChat();
});

const rows = (leadId) => db.prepare('SELECT * FROM outreach_queue WHERE lead_id = ? ORDER BY step').all(leadId);

test('a lead with a LinkedIn profile gets email day 0, a LinkedIn note day 1, emails days 3 and 7', async () => {
  let prompt = '';
  agent.setChat(async (m) => { prompt = m; return sequenceReply(); });
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const lee = rows(20);
  assert.deepEqual(lee.map(r => [r.step, r.channel, r.delay_days]), [[1, 'email', 0], [2, 'linkedin', 1], [3, 'email', 3], [4, 'email', 7]]);
  for (const r of lee.filter(r => r.channel === 'email')) assert.match(r.message, /\/call\.html\?t=[0-9a-f]{48}/, 'every email carries the voice link');
  const note = lee.find(r => r.channel === 'linkedin');
  assert.doesNotMatch(note.message, /https?:\/\//, 'no link in a LinkedIn note');
  assert.equal(note.subject, null);
  assert.match(prompt, /"has_linkedin":true/);
});

test('a lead without a LinkedIn profile gets no LinkedIn step, whatever the model returns', async () => {
  agent.setChat(async () => sequenceReply());
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  assert.deepEqual(rows(21).map(r => r.channel), ['email', 'email', 'email']);
});

test('a LinkedIn note over 300 characters is cut back to fit', async () => {
  agent.setChat(async () => sequenceReply({ note: LONG_NOTE }));
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const note = rows(20).find(r => r.channel === 'linkedin');
  assert.ok(note.message.length <= 300, `got ${note.message.length}`);
});

test('only phrases that are really in the message are kept as personalised', async () => {
  agent.setChat(async () => sequenceReply());
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const first = rows(20)[0];
  const hl = JSON.parse(first.highlights);
  assert.deepEqual(hl, [
    { text: 'the second Kulim plant', from: 'lead' },
    { text: 'leadership programmes for first-time managers', from: 'brief' },
  ]);
});

test('the LinkedIn note is never sent by the platform and does not hold up the emails after it', async () => {
  agent.setChat(async () => sequenceReply());
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  approveDrafts({ campaignId: 50, leadIds: [20], approvedBy: 2 });
  await processOutreachQueue({ campaignId: 50 });
  assert.equal(sent.length, 1, 'Day 0 email sent');
  db.prepare("UPDATE outreach_queue SET scheduled_at = datetime('now','-1 minute') WHERE lead_id = 20 AND status = 'pending'").run();
  await processOutreachQueue({ campaignId: 50 });
  assert.equal(sent.length, 2, 'the day-3 email went even though the LinkedIn note is not marked sent');
  assert.equal(rows(20).find(r => r.channel === 'linkedin').status, 'pending');
  assert.ok(sent.every(m => m.to[0] === 'shufen@velora.example'));
});

async function withRoutes(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business' }; next(); });
  app.use('/api/campaigns', campaignsRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, p, body) => {
    const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(call); } finally { s.close(); }
}

test('the team marks a LinkedIn note as sent from their own account; emails cannot be marked that way', async () => {
  agent.setChat(async () => sequenceReply());
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const note = rows(20).find(r => r.channel === 'linkedin');
  const email = rows(20).find(r => r.channel === 'email');
  await withRoutes(2, async (call) => {
    assert.equal((await call('POST', `/api/campaigns/50/outreach/${note.id}/linkedin-sent`)).status, 200);
    assert.equal((await call('POST', `/api/campaigns/50/outreach/${email.id}/linkedin-sent`)).status, 409);
  });
  await withRoutes(3, async (call) => {
    assert.equal((await call('POST', `/api/campaigns/50/outreach/${note.id}/linkedin-sent`)).status, 404);
  });
  assert.equal(db.prepare('SELECT status FROM outreach_queue WHERE id = ?').get(note.id).status, 'sent');
  assert.match(db.prepare("SELECT description FROM activities WHERE lead_id = 20 AND type = 'note'").get().description, /LinkedIn/);
  assert.equal(sent.length, 0);
});

test('Rewrite shorter rewrites a draft from the same brief and keeps the voice link', async () => {
  agent.setChat(async () => sequenceReply());
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const first = rows(20)[0];
  const link = first.message.match(/https:\/\/\S+\/call\.html\?t=[0-9a-f]+/)[0];
  let prompt = '';
  agent.setChat(async (m) => { prompt = m; return JSON.stringify({ subject: 'Kulim', message: 'Hi Shu Fen, saw the second Kulim plant. Open to a call? Aaron', personalised: ['the second Kulim plant', 'second Kulim plant'], from_brief: [] }); });
  await withRoutes(2, async (call) => {
    const r = await call('POST', `/api/campaigns/50/outreach/${first.id}/rewrite`, { length: 'shorter' });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /second Kulim plant/);
    assert.equal((await call('POST', `/api/campaigns/50/outreach/${first.id}/rewrite`, { length: 'sideways' })).status, 400);
  });
  const after = db.prepare('SELECT * FROM outreach_queue WHERE id = ?').get(first.id);
  assert.ok(after.message.includes(link), 'the voice link survives a rewrite that dropped it');
  assert.equal(after.subject, 'Kulim');
  assert.equal(after.status, 'draft');
  assert.deepEqual(JSON.parse(after.highlights), [{ text: 'the second Kulim plant', from: 'lead' }], 'a phrase inside a longer one is not highlighted twice');
  assert.match(prompt, /shorter/i);
  assert.match(prompt, /<sender_brief>/);
  assert.match(prompt, /HRD Corp claimable/);
});

test('only drafts can be rewritten, and only by the campaign owner', async () => {
  agent.setChat(async () => sequenceReply());
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  const first = rows(20)[0];
  db.prepare("UPDATE outreach_queue SET status = 'sent' WHERE id = ?").run(first.id);
  agent.setChat(async () => JSON.stringify({ subject: 'x', message: 'y' }));
  await withRoutes(2, async (call) => {
    assert.equal((await call('POST', `/api/campaigns/50/outreach/${first.id}/rewrite`, { length: 'longer' })).status, 409);
  });
  await withRoutes(3, async (call) => {
    assert.equal((await call('POST', `/api/campaigns/50/outreach/${rows(20)[2].id}/rewrite`, { length: 'longer' })).status, 404);
  });
});
