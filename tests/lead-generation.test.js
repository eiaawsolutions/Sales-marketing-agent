import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-leadgen-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
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
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', ?)`).run(plan);
  globalThis.fetch = realFetch;
  agent.resetChat();
  for (const k of ['CRAWL4AI_URL', 'CRAWL4AI_API_TOKEN', 'REACHER_URL']) delete process.env[k];
}
beforeEach(() => reset());

// The self-hosted website reader (Crawl4AI) and mailbox check (Reacher),
// stubbed: `pages` is markdown by URL, `reachable` is Reacher's verdict.
function leadTools({ pages = {}, reachable = 'safe' } = {}) {
  process.env.CRAWL4AI_URL = 'http://crawl4ai.railway.internal:11235';
  process.env.CRAWL4AI_API_TOKEN = 'test-token';
  process.env.REACHER_URL = 'http://reacher.railway.internal:8080';
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (String(url).startsWith(process.env.CRAWL4AI_URL)) {
      return body.url in pages
        ? new Response(JSON.stringify({ markdown: pages[body.url], success: true }), { status: 200 })
        : new Response('{}', { status: 500 });
    }
    if (String(url).startsWith(process.env.REACHER_URL)) {
      return new Response(JSON.stringify({ input: body.to_email, is_reachable: reachable, misc: {}, mx: { accepts_mail: true }, smtp: {} }), { status: 200 });
    }
    return realFetch(url, init);
  };
}

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

test("a person found without an email is kept when their company's own site publishes it", async () => {
  leadTools({ pages: {
    'https://velora.example/': 'Velora. [Our team](/our-team)',
    'https://velora.example/our-team': 'Lee Shu Fen — Director, L&D — shufen.lee@velora.example',
  } });
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return JSON.stringify({ leads: [webLead('')] }); });
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.match(prompt, /return them with "email": ""/);
  assert.equal(res.generated, 1);
  const lead = db.prepare('SELECT email, notes FROM leads WHERE user_id = 2').get();
  assert.equal(lead.email, 'shufen.lee@velora.example');
  assert.match(lead.notes, /Email found on: https:\/\/velora\.example\/our-team/);
  assert.match(lead.notes, /Verification: .*https:\/\/velora\.example\/our-team/);
  assert.match(lead.notes, /Mailbox check: deliverable/);
});

test('an address the mail server rejects is discarded, and the reason is shown', async () => {
  leadTools({ reachable: 'invalid' });
  agent.setChat(async () => JSON.stringify({ leads: [webLead('shufen.lee@velora.example')] }));
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.equal(res.generated, 0);
  assert.equal(res.rejected, 1);
  assert.match(res.rejectedLeads[0].reason, /mailbox check: the mail server says this address does not exist/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM leads WHERE user_id = 2').get().c, 0);
});

test('a person the company site does not publish an email for is still discarded', async () => {
  leadTools({ pages: { 'https://velora.example/': 'Velora. Contact info@velora.example' } });
  agent.setChat(async () => JSON.stringify({ leads: [webLead('')] }));
  const res = await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.equal(res.generated, 0);
  assert.match(res.rejectedLeads[0].reason, /no public email/);
});

test("with the website reader on, every lead without an email must come with its company's website or LinkedIn profile", async () => {
  leadTools();
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return JSON.stringify({ leads: [] }); });
  await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.match(prompt, /"company_website": .*REQUIRED for every lead without an email, unless you give their LinkedIn profile/);
  assert.match(prompt, /no email, no company_website and no such profile will be REJECTED/);
});

test('the search log counts discards by reason and never names the people discarded', async () => {
  agent.setChat(async () => JSON.stringify({ leads: [
    { ...webLead(''), name: 'Sabrie Salleh' },
    { ...webLead('hr@permata.example'), name: 'Daniel Lim' },
    { ...webLead('nurul@seri.example'), name: 'Nurul Huda' },
    { ...webLead('nurul@seri.example'), name: 'Nurul Huda' },
  ] }));
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  } finally {
    console.log = realLog;
  }
  const text = logged.join('\n');
  assert.match(text, /Rejected 2 leads/);
  assert.match(text, /no public email found/);
  assert.match(text, /1 in-batch duplicate/);
  for (const secret of ['Sabrie', 'Daniel', 'Nurul', 'hr@permata.example', 'nurul@seri.example']) {
    assert.ok(!text.includes(secret), `the log names ${secret}`);
  }
});

test('without the website reader the search asks for public emails, or a LinkedIn profile from the search results', async () => {
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return JSON.stringify({ leads: [] }); });
  await runAgent(2, 'generate_leads', { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 });
  assert.match(prompt, /Anyone else without a public email MUST BE DISCARDED/);
  assert.match(prompt, /no public email may be returned only if their personal LinkedIn profile .* appeared in your search results/);
  assert.doesNotMatch(prompt, /return them with "email": ""/, 'no promise that their company website will be read');
});

test('a rejected AI key during lead search is reported as the AI key', async () => {
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
