import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// The brief is how a customer's outreach comes to be about the customer's
// offer: every AI-written message, score and campaign email is built from it,
// and nothing is drafted for a customer whose offer is not on file.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-brief-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { launchCampaignPipeline } = await import('../src/services/pipeline-automation.js');
const { default: profileRouter } = await import('../src/routes/profile.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const TLL = {
  business_name: 'The Leadership Lab', sender_name: 'Aaron Joseph', sender_title: 'Founder',
  offer: 'Leadership programmes for first-time managers and mid-level leaders',
  proof_points: 'HRD Corp claimable for levy-paying employers',
  call_to_action: 'a 20-minute call to compare notes on your 2027 leadership calendar',
  tone: 'warm', reply_to_email: 'aaron@tll.example', meeting_link: 'https://meet.google.com/abc-defg-hij',
};

function reset() {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')`).run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, title, notes) VALUES (20, 2, 'Lee Shu Fen', 'shufen@velora.example', 'Velora', 'Director, L&D', 'Buying signal: opened a second plant in Kulim, hiring 9 supervisors')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, target_audience) VALUES (50, 2, 'TLL Q4', 'email', 'active', 'Hi', 'HR Directors')").run();
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, 20)').run();
  agent.resetChat();
}
beforeEach(reset);

async function as(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business', email: 'aaron@tll.example' }; next(); });
  app.use('/api/profile', profileRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, body) => {
    const res = await fetch(`${base}/api/profile`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test('the brief starts with approval on, saves valid input and rejects bad links and emails', async () => {
  await as(2, async (call) => {
    const empty = await call('GET');
    assert.equal(empty.body.profile.outreach_approval, 1);
    assert.equal(empty.body.ready, false);

    const bad = await call('PUT', { reply_to_email: 'not-an-email', meeting_link: 'http://insecure.example' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.reply_to_email && bad.body.errors.meeting_link);

    const ok = await call('PUT', TLL);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.profile.business_name, 'The Leadership Lab');
    assert.equal(ok.body.ready, true);
    assert.equal(ok.body.sender.fromName, 'Aaron Joseph (The Leadership Lab)');
  });
});

test("outreach is written about the account's offer, its true claims and the lead's signals", async () => {
  await as(2, (call) => call('PUT', TLL));
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return '{"sequences":[]}'; });
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  assert.match(prompt, /The Leadership Lab/);
  assert.match(prompt, /first-time managers/);
  assert.match(prompt, /HRD Corp claimable/);
  assert.match(prompt, /second plant in Kulim/, "the lead's buying signal reaches the writer");
  assert.match(prompt, /never invent/i);
  assert.doesNotMatch(prompt, /EIAAW|voice demo/i);
});

test('without an offer on file, a customer account gets no invented outreach', async () => {
  let called = false;
  agent.setChat(async () => { called = true; return '{"sequences":[]}'; });
  await assert.rejects(() => runAgent(2, 'auto_outreach', { campaignId: 50 }), /Brief/);
  assert.equal(called, false);
});

test('Launch writes the campaign email from the brief, never about EIAAW', async () => {
  await as(2, (call) => call('PUT', TLL));
  db.prepare("UPDATE campaigns SET body = NULL WHERE id = 50").run();
  db.prepare('UPDATE leads SET score = 50').run();
  const prompts = [];
  agent.setChat(async (message) => {
    prompts.push(message);
    if (message.includes('"sequences"')) return '{"sequences":[]}';
    return '{"subject":"s","body_html":"<p>b</p>","body_text":"b"}';
  });
  await launchCampaignPipeline(2, 50);
  const emailPrompt = prompts.find(p => /email/i.test(p) && /Leadership Lab/.test(p));
  assert.ok(emailPrompt, 'campaign email prompt names the business');
  assert.ok(prompts.every(p => !/EIAAW AI Sales Agent/.test(p)));
});

test('lead scoring reads the lead\'s signals and the offer it is scored against', async () => {
  await as(2, (call) => call('PUT', TLL));
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return '{"score":80,"reasoning":"fit","recommended_action":"send"}'; });
  await runAgent(2, 'score_lead', { leadId: 20 });
  assert.match(prompt, /second plant in Kulim/);
  assert.match(prompt, /first-time managers/);
});
