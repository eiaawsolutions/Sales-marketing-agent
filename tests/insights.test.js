import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// The board shows every lead by stage with what matters about it now; the
// Monday brief and the pipeline review count the account's own facts and add
// the assistant's reading; the monthly report counts what the agent did.
// Each is the account's own data only.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-insights-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');
const { boardFor } = await import('../src/services/pipeline-board.js');
const { writeBrief, runMondayBriefs, weekOf } = await import('../src/services/weekly-brief.js');
const { monthlyReport, runMonthlyReports, currentMonth } = await import('../src/services/monthly-report.js');
const { suppress } = await import('../src/services/unsubscribe.js');
const { default: pipelineRouter } = await import('../src/routes/pipeline.js');
const { default: reportsRouter } = await import('../src/routes/reports.js');

const realFetch = globalThis.fetch;
let mails = [];
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const soon = (h) => new Date(Date.now() + h * 3600000).toISOString();
const sqlAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
  for (const t of ['briefs', 'replies', 'pipeline', 'appointments', 'outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'email_suppressions', 'leads', 'campaigns', 'account_profiles', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `owner${id}@example.com`);
  }
  db.prepare("INSERT INTO account_profiles (user_id, business_name, offer, reply_to_email) VALUES (2, 'The Leadership Lab', 'Leadership programmes', 'aaron@tll.example')").run();
  const lead = (id, name, status, source = 'ai_generated', user = 2) =>
    db.prepare('INSERT INTO leads (id, user_id, name, email, company, status, source, score) VALUES (?, ?, ?, ?, ?, ?, ?, 70)').run(id, user, name, `${name.split(' ')[0].toLowerCase()}@x${id}.example`, `Co ${id}`, status, source);
  lead(1, 'Bayu New', 'new');
  lead(2, 'Seri Contacted', 'contacted');
  lead(3, 'Velora Qualified', 'qualified');
  lead(4, 'Lumina Qualified', 'qualified');
  lead(5, 'Cendana Nurture', 'contacted');
  lead(6, 'Harbour Optout', 'contacted');
  lead(7, 'Mutiara Lost', 'lost');
  lead(8, 'Farhana Referral', 'new', 'referral');
  lead(9, 'Other Account', 'qualified', 'ai_generated', 3);
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status) VALUES (50, 2, 'C', 'email', 'active')").run();
  for (const l of [2, 5, 6]) db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status, sent_at, opened_at) VALUES (50, ?, 'opened', ?, ?)").run(l, sqlAgo(8), sqlAgo(7));
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, sent_at, user_id) VALUES (50, 2, 1, 'email', 'm', 'sent', 0, ?, 2)").run(sqlAgo(3));
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, scheduled_at, user_id) VALUES (50, 2, 2, 'email', 'm', 'pending', 3, datetime('now','+1 day'), 2)").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, scheduled_at, user_id) VALUES (50, 2, 3, 'email', 'm', 'pending', 7, datetime('now','+5 day'), 2)").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, user_id) VALUES (50, 1, 1, 'email', 'm', 'draft', 0, 2)").run();
  db.prepare("INSERT INTO replies (user_id, lead_id, source, body, intent, confidence, status, received_at) VALUES (2, 3, 'inbound', 'Thursday?', 'interested', 0.96, 'new', ?)").run(sqlAgo(1));
  db.prepare("INSERT INTO replies (user_id, lead_id, source, body, intent, status, received_at) VALUES (2, 5, 'pasted', 'April', 'not_now', 'answered', ?)").run(sqlAgo(2));
  db.prepare("INSERT INTO replies (user_id, lead_id, source, body, intent, status, received_at) VALUES (2, 2, 'inbound', 'away', 'out_of_office', 'dismissed', ?)").run(sqlAgo(2));
  db.prepare("INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, status, type) VALUES (4, 2, 'Lumina with Aaron', ?, 30, 'confirmed', 'meeting')").run(soon(50));
  db.prepare("INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, status, type, notes) VALUES (5, 2, 'Revisit Cendana', ?, 15, 'scheduled', 'follow_up', 'Vendor list set')").run(soon(24 * 120));
  db.prepare("INSERT INTO pipeline (user_id, lead_id, stage, deal_value, probability) VALUES (2, 4, 'qualification', 36000, 30)").run();
  suppress({ userId: 2, email: 'harbour@x6.example', reason: 'unsubscribe', leadId: 6 });
  mails = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: `re_${mails.length}` })); }
    return realFetch(url, init);
  };
  agent.setChat(async () => JSON.stringify({ headline: 'Two qualified deals; one meeting this week.', stuck: '2 contacted leads opened but have not replied.', focus: 'Answer Velora today.' }));
});

const card = (b, stage, name) => b.columns[stage].cards.find(c => c.name === name);

test('the board puts every lead in its stage with what matters about it now', () => {
  const b = boardFor(2);
  assert.equal(b.columns.new.count, 2);
  assert.equal(b.columns.contacted.count, 3);
  assert.equal(b.columns.qualified.count, 2);
  assert.equal(b.lost, 1);
  assert.equal(card(b, 'new', 'Bayu New').hint, 'Sequence waiting for approval');
  assert.equal(card(b, 'contacted', 'Seri Contacted').hint, 'Day 0 of 7');
  assert.equal(card(b, 'qualified', 'Velora Qualified').hint, 'Reply waiting for you');
  assert.match(card(b, 'qualified', 'Lumina Qualified').hint, /^Meeting /);
  assert.equal(card(b, 'qualified', 'Lumina Qualified').deal_value, 36000);
  assert.match(card(b, 'contacted', 'Cendana Nurture').hint, /^Nurture · revisit/);
  assert.equal(card(b, 'contacted', 'Harbour Optout').hint, 'Opted out');
  assert.equal(card(b, 'new', 'Farhana Referral').hint, 'Referral');
  assert.ok(!Object.values(b.columns).some(c => c.cards.some(x => x.name === 'Other Account')));
});

test('a review counts the account\'s facts and adds the assistant\'s reading of them', async () => {
  let prompt = '';
  agent.setChat(async (m) => { prompt = m; return JSON.stringify({ headline: 'h', stuck: 's', focus: 'f' }); });
  const b = await writeBrief(2, { kind: 'review' });
  const f = b.facts;
  assert.equal(f.waiting_for_you.replies, 1);
  assert.deepEqual(f.waiting_for_you.reply_from, ['Velora Qualified']);
  assert.equal(f.waiting_for_you.drafts_to_approve, 1);
  assert.equal(f.meetings_this_week.length, 1);
  assert.equal(f.stuck.opened_but_no_reply, 3);
  assert.equal(f.stuck.qualified_without_meeting, 1);
  assert.equal(f.last_7_days.replies, 2, 'an automatic away message is not a reply');
  assert.equal(f.last_7_days.positive_replies, 1);
  assert.equal(f.open_deal_value_myr, 36000);
  assert.deepEqual(b.narrative, { headline: 'h', stuck: 's', focus: 'f' });
  assert.match(prompt, /<facts>/);
  assert.doesNotMatch(prompt, /Other Account/);
});

test('if the AI fails the brief still has the facts', async () => {
  agent.setChat(async () => { throw new Error('overloaded'); });
  const b = await writeBrief(2, { kind: 'review' });
  assert.equal(b.narrative, null);
  assert.equal(b.facts.waiting_for_you.replies, 1);
});

test('the Monday brief goes to each account with leads once a week, however often the job runs', async () => {
  assert.equal(await runMondayBriefs(), 2);
  assert.equal(await runMondayBriefs(), 0);
  const tll = mails.find(m => m.to[0] === 'aaron@tll.example');
  assert.match(tll.subject, /Monday brief — 1 meeting, 1 reply waiting/);
  assert.match(tll.html, /Answer Velora today|Two qualified deals/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM briefs WHERE kind = 'weekly' AND period = ?").get(weekOf()).c, 2);
});

test('the monthly report counts verified leads, replies, meetings and cost per meeting', () => {
  const r = monthlyReport(2, currentMonth());
  assert.equal(r.verified_leads, 8, 'seven from search and one referral, all created this month');
  assert.equal(r.prospects_emailed, 1);
  assert.equal(r.replies, 2);
  assert.equal(r.reply_rate, 200);
  assert.equal(r.positive_replies, 1);
  assert.equal(r.meetings_booked, 1);
  assert.equal(r.plan_price_myr, 399);
  assert.equal(r.cost_per_meeting_myr, 399);
});

async function as(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business' }; next(); });
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/reports', reportsRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, p, body) => { const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try { await fn(call); } finally { s.close(); }
}

test('board, review and report routes read only the signed-in account', async () => {
  await as(3, async (call) => {
    const b = await call('GET', '/api/pipeline/board');
    assert.equal(b.body.columns.qualified.count, 1);
    assert.equal((await call('GET', `/api/reports/monthly?month=${currentMonth()}`)).body.verified_leads, 1);
  });
  await as(2, async (call) => {
    const review = await call('POST', '/api/pipeline/brief');
    assert.equal(review.status, 200);
    assert.ok(review.body.lines.some(l => /repl(y|ies) waiting/.test(l)));
    assert.equal((await call('GET', '/api/pipeline/brief')).body.id, review.body.id);
    assert.equal((await call('POST', '/api/reports/monthly/email', { month: currentMonth() })).status, 400, 'only a finished month');
  });
});

test('the monthly job emails last month\'s report only to accounts that did something', async () => {
  assert.equal(await runMonthlyReports(), 0, 'nothing happened last month in this fixture');
});
