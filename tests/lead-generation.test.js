import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-leadgen-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.APOLLO_API_KEY;
delete process.env.RESEND_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { checkPlanLimitForUser } = await import('../src/middleware/auth.js');
const { launchCampaignPipeline } = await import('../src/services/pipeline-automation.js');
const { isRoleMailbox } = await import('../src/utils/normalize.js');

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

function reset(plan = 'business') {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'leads', 'campaigns', 'ai_cost_log', 'agent_tasks', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key = 'apollo_api_key'").run();
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', ?)`).run(plan);
  globalThis.fetch = realFetch;
  agent.resetChat();
}
beforeEach(() => reset());

const webLead = (email, name = 'Lee Shu Fen') => ({
  name, type: 'B2B', title: 'Director, L&D', company: 'Velora', geography: 'Kulim', lead_type: 'Cold', email,
  phone: '', other_contact: '', linkedin_url: 'https://www.linkedin.com/in/example', company_website: 'https://velora.example',
  verification_sources: ['https://velora.example/team'], reason_for_fit: 'Owns L&D', buying_signal: '', confidence_score: 'High',
  enrichment: '', source: 'ai_generated',
});

test('role inboxes are recognised, personal addresses are not', () => {
  for (const e of ['hr@co.my', 'HR@co.my', 'careers@co.my', 'info@co.my', 'enquiries@co.my', 'admin@co.my', 'recruitment@co.my', 'no-reply@co.my', 'talent@co.my']) {
    assert.equal(isRoleMailbox(e), true, e);
  }
  for (const e of ['shufen.lee@co.my', 'aaron@tll.example', 'hrishikesh@co.my', 'info.sales.lead@co.my']) {
    assert.equal(isRoleMailbox(e), false, e);
  }
});

test('lead search works when the account already holds a lead with no email', async () => {
  db.prepare("INSERT INTO leads (user_id, name, email, phone) VALUES (2, 'Phone Only', NULL, '+60123456789')").run();
  agent.setChat(async () => JSON.stringify({ leads: [webLead('shufen.lee@velora.example')] }));
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.equal(res.generated, 1);
});

test('web-search leads with a role inbox (hr@, careers@) are discarded', async () => {
  agent.setChat(async () => JSON.stringify({ leads: [
    webLead('hr@permata.example', 'Daniel Lim'), webLead('careers@harbour.example', 'Jason Ong'), webLead('nurul@seri.example', 'Nurul Huda'),
  ] }));
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.equal(res.generated, 1);
  assert.equal(res.rejected, 2);
  assert.deepEqual(db.prepare('SELECT email FROM leads WHERE user_id = 2').all().map(r => r.email), ['nurul@seri.example']);
});

test('Apollo leads with a role inbox are discarded too', async () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('apollo_api_key', 'apollo_test_key_123')").run();
  const people = {
    p1: { id: 'p1', name: 'Daniel Lim', title: 'HR Director', email: 'hr@permata.example', email_status: 'verified', linkedin_url: 'https://www.linkedin.com/in/daniel', organization: { name: 'Permata', website_url: 'https://permata.example' } },
    p2: { id: 'p2', name: 'Grace Tan', title: 'Head of Talent', email: 'grace.tan@lumina.example', email_status: 'verified', linkedin_url: 'https://www.linkedin.com/in/grace', organization: { name: 'Lumina', website_url: 'https://lumina.example' } },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('apollo.io')) {
      const body = init?.body ? JSON.parse(init.body) : {};
      const json = String(url).includes('match') ? { person: people[body.id] } : { people: Object.values(people).map(p => ({ id: p.id, name: p.name, organization: p.organization })) };
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  agent.setChat(async (message) => (message.includes('100% match') ? '{"match":true,"reason":"HR leader in Malaysia"}' : '{"person_titles":["HR Director"]}'));
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.equal(res.sourceProvider, 'apollo');
  assert.deepEqual(db.prepare('SELECT email FROM leads WHERE user_id = 2').all().map(r => r.email), ['grace.tan@lumina.example']);
});

test('when Apollo turns down its key, the search still runs on the open web and says why', async () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('apollo_api_key', 'apollo_revoked_key')").run();
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('apollo.io')) {
      return new Response(JSON.stringify({ error: 'Invalid access credentials.' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  agent.setChat(async (message, _ctx, options = {}) => (options.useWebSearch
    ? JSON.stringify({ leads: [webLead('shufen.lee@velora.example')] })
    : '{"person_titles":["HR Director"]}'));
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.equal(res.sourceProvider, 'ai_websearch');
  assert.equal(res.fallbackFrom, 'apollo');
  assert.match(res.apolloError, /rejected/);
  assert.equal(res.generated, 1);
});

test('a rejected AI key on the Apollo path is reported as the AI key, not as Apollo', async () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('apollo_api_key', 'apollo_test_key_123')").run();
  agent.setChat(async () => {
    throw Object.assign(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { status: 401 });
  });
  await assert.rejects(
    runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 }),
    /AI service turned down/,
  );
});

test('the monthly verified-lead allowance counts Apollo leads as well as web-search leads', () => {
  const ins = db.prepare("INSERT INTO leads (user_id, name, email, source) VALUES (2, ?, ?, ?)");
  for (let i = 0; i < 140; i++) ins.run(`L${i}`, `l${i}@x.example`, i % 2 ? 'apollo' : 'ai_generated');
  assert.throws(() => checkPlanLimitForUser({ id: 2, role: 'user', plan: 'business' }, 'ai_leads_per_month'), /limit reached/);
});

test('Launch on Starter neither generates leads nor drafts outreach (not in the plan)', async () => {
  reset('starter');
  let calls = 0;
  agent.setChat(async () => { calls++; return '{"leads":[]}'; });
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, target_audience, subject, body) VALUES (5, 2, 'C', 'email', 'draft', 'HR Directors', 'Hi', '<p>x</p>')").run();
  await launchCampaignPipeline(2, 5);
  assert.equal(calls, 0);
  const log = JSON.parse(db.prepare('SELECT pipeline_log FROM campaigns WHERE id = 5').get().pipeline_log).map(e => e.msg).join('\n');
  assert.match(log, /Step 1: Skipped .*Pro and Business/);
});

test('Launch only asks for what is left of the monthly allowance', async () => {
  const ins = db.prepare("INSERT INTO leads (user_id, name, email, source) VALUES (2, ?, ?, 'apollo')");
  for (let i = 0; i < 137; i++) ins.run(`L${i}`, `l${i}@x.example`);
  let genPrompt = '';
  agent.setChat(async (message) => {
    if (message.includes('lead generation and verification engine')) { genPrompt = message; return '{"leads":[]}'; }
    return '{"sequences":[]}';
  });
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, target_audience, subject, body) VALUES (6, 2, 'C', 'email', 'draft', 'HR Directors', 'Hi', '<p>x</p>')").run();
  await launchCampaignPipeline(2, 6);
  assert.match(genPrompt, /Requested lead count \(maximum, not a quota\): 3\b/);
});
