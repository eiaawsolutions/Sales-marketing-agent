import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// "Who you sell to" goes in once, on the Brief. Every search, score and
// message after that is built from it: a search runs from the Brief alone,
// keeps only verified people, says what it threw away and why, and counts
// against the month's allowance. Editing the offer can redraft drafts that
// nobody has approved yet; approved and sent messages are never touched.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-market-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.APOLLO_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');
const { audienceFromBrief } = await import('../src/services/account-profile.js');
const { launchCampaignPipeline } = await import('../src/services/pipeline-automation.js');
const { default: profileRouter } = await import('../src/routes/profile.js');
const { default: leadsRouter } = await import('../src/routes/leads.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const MARKET = {
  ideal_client: 'Malaysian companies with 200+ employees growing their management layer',
  target_roles: ['HR Director', 'Head of L&D', 'L&D Manager', 'CHRO', 'HR Director'],
  target_sectors: ['Manufacturing', 'Semiconductor', 'Healthcare'],
  target_regions: ['Klang Valley', 'Penang & Kedah'],
  company_size: '200+',
};

beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'users', 'settings']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')").run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (4, 'small', 's@small.example', 'x', 'user', 'active', 'starter')").run();
  db.prepare(`INSERT INTO account_profiles (user_id, business_name, sender_name, offer, proof_points, tone)
              VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes for first-time managers', 'HRD Corp claimable', 'warm')`).run();
  agent.resetChat();
});

function server(userId, plan = 'business') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan }; next(); });
  app.use('/api/profile', profileRouter);
  app.use('/api/leads', leadsRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { call, close: () => s.close() };
}

test('the brief stores who you sell to: lists are trimmed and de-duplicated, and size must be a known band', async () => {
  const { call, close } = server(2);
  try {
    const bad = await call('PUT', '/api/profile', { company_size: 'huge' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.company_size);

    const ok = await call('PUT', '/api/profile', MARKET);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.profile.target_roles, ['HR Director', 'Head of L&D', 'L&D Manager', 'CHRO']);
    assert.deepEqual(ok.body.profile.target_regions, ['Klang Valley', 'Penang & Kedah']);
    assert.equal(ok.body.profile.company_size, '200+');
    assert.equal(ok.body.market_ready, true);
  } finally { close(); }
});

test('the search audience is written from the brief', async () => {
  const { call, close } = server(2);
  try { await call('PUT', '/api/profile', MARKET); } finally { close(); }
  const a = audienceFromBrief(2);
  assert.match(a, /growing their management layer/);
  assert.match(a, /HR Director, Head of L&D, L&D Manager, CHRO/);
  assert.match(a, /Manufacturing, Semiconductor, Healthcare/);
  assert.match(a, /Klang Valley; Penang & Kedah/);
  assert.match(a, /200\+ employees/);
});

const VERIFIED = (n) => ({
  name: `Person ${n}`, type: 'B2B', title: 'HR Director', company: `Co ${n}`, geography: 'Kuala Lumpur', lead_type: 'Hot',
  email: `person${n}@co${n}.example`, phone: '', linkedin_url: `https://www.linkedin.com/in/person${n}`, company_website: `https://co${n}.example`,
  verification_sources: [`https://co${n}.example/team`], reason_for_fit: 'HR Director at a 500-person manufacturer',
  buying_signal: 'Hiring 9 supervisors', confidence_score: 'High', source: 'ai_generated',
});

test('Find decision-makers runs from the brief, keeps verified people, and reports what it discarded and why', async () => {
  let searchPrompt = '';
  agent.setChat(async (message, _x, opts) => {
    if (opts?.useWebSearch) {
      searchPrompt = message;
      return JSON.stringify({ leads: [
        VERIFIED(1), VERIFIED(2),
        { ...VERIFIED(3), email: 'hr@co3.example' },
        { ...VERIFIED(4), email: '', confidence_score: 'High' },
        { ...VERIFIED(5), confidence_score: 'Low' },
      ] });
    }
    return '{}';
  });
  const { call, close } = server(2);
  try {
    await call('PUT', '/api/profile', MARKET);
    const r = await call('POST', '/api/leads/find', { count: 50 });
    assert.equal(r.status, 200);
    assert.equal(r.body.kept, 2);
    assert.equal(r.body.discarded, 3);
    assert.equal(r.body.found, 5);
    assert.ok(r.body.discarded_list.some(d => /generic mailbox/.test(d.reason)));
    assert.equal(r.body.used_this_month, 2);
    assert.equal(r.body.monthly_limit, 140);
    assert.ok(r.body.campaign_id, 'kept leads go into the account\'s brief campaign');
  } finally { close(); }
  assert.match(searchPrompt, /Requested lead count \(maximum, not a quota\): 15/, 'a run is capped at 15');
  assert.match(searchPrompt, /Head of L&D/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM leads WHERE user_id = 2").get().c, 2, 'discarded people are not stored');
  const camp = db.prepare("SELECT name, target_audience FROM campaigns WHERE user_id = 2").get();
  assert.equal(camp.name, 'Outreach from your Brief');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM campaign_leads').get().c, 2);
});

test('a search needs a market on the brief, and a plan that includes lead search', async () => {
  const a = server(2);
  try {
    const r = await a.call('POST', '/api/leads/find', {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /who you sell to/i);
  } finally { a.close(); }
  const b = server(4, 'starter');
  try {
    const r = await b.call('POST', '/api/leads/find', {});
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Pro and Business/);
  } finally { b.close(); }
});

test('a campaign with no audience of its own searches from the brief', async () => {
  const { call, close } = server(2);
  try { await call('PUT', '/api/profile', MARKET); } finally { close(); }
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject) VALUES (60, 2, 'Q4', 'email', 'draft', 'Hi')").run();
  let searched = '';
  agent.setChat(async (message, _x, opts) => {
    if (opts?.useWebSearch) { searched = message; return '{"leads":[]}'; }
    if (message.includes('"sequences"')) return '{"sequences":[]}';
    return '{"subject":"s","body_html":"<p>b</p>","body_text":"b"}';
  });
  await launchCampaignPipeline(2, 60);
  assert.match(searched, /Head of L&D/);
});

function seedDrafts() {
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (20, 2, 'Lee Shu Fen', 'shufen@velora.example', 'Velora')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (21, 2, 'Nurul Huda', 'nurul@seri.example', 'Seri Andalas')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status) VALUES (70, 2, 'C', 'email', 'active')").run();
  for (const l of [20, 21]) db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (70, ?)').run(l);
  for (const step of [1, 2, 3]) {
    db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, user_id) VALUES (70, 20, ?, 'email', 'old offer', 'draft', 2)").run(step);
    db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, user_id) VALUES (70, 21, ?, 'email', 'old offer', ?, 2)").run(step, step === 1 ? 'sent' : 'pending');
  }
}

test('redrafting rewrites only sequences nobody has approved, from the brief as it is now', async () => {
  seedDrafts();
  db.prepare("UPDATE account_profiles SET offer = 'Half-day modular leadership workshops' WHERE user_id = 2").run();
  let prompt = '';
  agent.setChat(async (message) => {
    prompt = message;
    return JSON.stringify({ sequences: [{ lead_name: 'Lee Shu Fen', steps: [
      { step: 1, channel: 'email', delay_days: 0, subject: 'New', message: 'Workshops {{CALL_LINK}}', goal: 'g' },
      { step: 2, channel: 'email', delay_days: 3, subject: 'New 2', message: 'Workshops 2 {{CALL_LINK}}', goal: 'g' },
      { step: 3, channel: 'email', delay_days: 7, subject: 'New 3', message: 'Workshops 3 {{CALL_LINK}}', goal: 'g' },
    ] }] });
  });
  const { call, close } = server(2);
  try {
    const before = await call('GET', '/api/profile');
    assert.equal(before.body.drafts_waiting, 3);
    const r = await call('POST', '/api/profile/redraft');
    assert.equal(r.status, 200);
    assert.equal(r.body.leads_redrafted, 1);
  } finally { close(); }
  assert.match(prompt, /Half-day modular leadership workshops/);
  const lee = db.prepare("SELECT message, status FROM outreach_queue WHERE lead_id = 20 ORDER BY step").all();
  assert.equal(lee.length, 3);
  assert.ok(lee.every(r => r.status === 'draft' && /^Workshops/.test(r.message)));
  const nurul = db.prepare("SELECT message FROM outreach_queue WHERE lead_id = 21").all();
  assert.ok(nurul.every(r => r.message === 'old offer'), 'an approved sequence is never rewritten');
});

test('only the account owner can redraft', async () => {
  seedDrafts();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 2, role: 'user', plan: 'business', isMember: true, memberId: 9 }; next(); });
  app.use('/api/profile', profileRouter);
  const s = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/profile/redraft`, { method: 'POST' });
    assert.equal(r.status, 403);
  } finally { s.close(); }
});

test('a sequence approved while it was being redrafted is left alone — never doubled', async () => {
  seedDrafts();
  agent.setChat(async () => {
    // A teammate approves Lee's sequence while the AI is writing the new one.
    db.prepare("UPDATE outreach_queue SET status = 'pending' WHERE lead_id = 20").run();
    return JSON.stringify({ sequences: [{ lead_name: 'Lee Shu Fen', steps: [
      { step: 1, channel: 'email', delay_days: 0, subject: 'New', message: 'New {{CALL_LINK}}', goal: 'g' },
      { step: 2, channel: 'email', delay_days: 3, subject: 'New 2', message: 'New 2 {{CALL_LINK}}', goal: 'g' },
    ] }] });
  });
  const { call, close } = server(2);
  try { await call('POST', '/api/profile/redraft'); } finally { close(); }
  const lee = db.prepare('SELECT message, status FROM outreach_queue WHERE lead_id = 20').all();
  assert.equal(lee.length, 3, 'no second sequence');
  assert.ok(lee.every(r => r.message === 'old offer' && r.status === 'pending'));
});
