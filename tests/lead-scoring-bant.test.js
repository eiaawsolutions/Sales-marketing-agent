import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Every score is Budget, Authority, Need and Timeline, 0–25 each, with a
// written note per factor. The score out of 100 is their sum, so the number
// and the reasons can never disagree. The breakdown is kept on the lead and
// shown with the signals it came from.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-bant-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { default: leadsRouter } = await import('../src/routes/leads.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const NOTES = [
  'Fit: Owns L&D for the region',
  'Lead type: Hot (confidence: High)',
  'Buying signal: Opened a second plant in September, hiring 9 supervisors',
  'Enrichment: Posted about building leaders from within',
  'Profile: https://www.linkedin.com/in/shufen-example',
  'Website: https://velora.example',
  'Verification: https://velora.example/team | https://news.example/velora-plant',
].join('\n');

beforeEach(() => {
  for (const t of ['activities', 'ai_cost_log', 'agent_tasks', 'leads', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `o${id}@example.com`);
  }
  db.prepare("INSERT INTO account_profiles (user_id, business_name, offer, proof_points) VALUES (2, 'The Leadership Lab', 'Leadership programmes for first-time managers', 'HRD Corp claimable')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, title, notes) VALUES (20, 2, 'Lee Shu Fen', 'shufen@velora.example', 'Velora', 'Director, L&D', ?)").run(NOTES);
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (30, 3, 'Not Yours', 'n@other.example', 'Other')").run();
});

function scoreAs(result) {
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return JSON.stringify(result); });
  return () => prompt;
}

const BANT = {
  budget: { score: 22, note: 'Levy-paying employer of 3,000' },
  authority: { score: 24, note: 'Owns L&D for the region' },
  need: { score: 23, note: 'Second plant, new line leaders' },
  timeline: { score: 19, note: '2027 calendar being set now' },
};

test('a score is the sum of its four BANT factors, and the breakdown is kept on the lead', async () => {
  const promptOf = scoreAs({ bant: BANT, reasoning: 'Strong fit on every count.', recommended_action: 'Send the sequence this week.' });
  const r = await runAgent(2, 'score_lead', { leadId: 20 });
  assert.equal(r.score, 88);
  const lead = db.prepare('SELECT score, score_detail FROM leads WHERE id = 20').get();
  assert.equal(lead.score, 88);
  const detail = JSON.parse(lead.score_detail);
  assert.deepEqual(Object.keys(detail.bant), ['budget', 'authority', 'need', 'timeline']);
  assert.equal(detail.bant.need.note, 'Second plant, new line leaders');
  assert.equal(detail.reasoning, 'Strong fit on every count.');
  assert.equal(detail.next_step, 'Send the sequence this week.');
  assert.match(promptOf(), /Budget/);
  assert.match(promptOf(), /<lead_data>/, 'lead data is fenced as untrusted');
  assert.match(promptOf(), /Leadership programmes for first-time managers/, 'fit is judged against this account\'s offer');
  const act = db.prepare("SELECT description FROM activities WHERE lead_id = 20 AND type = 'ai_action'").get();
  assert.match(act.description, /88\/100/);
});

test('out-of-range factor scores are clamped to 0–25, so the total stays within 0–100', async () => {
  scoreAs({ bant: { budget: { score: 40, note: 'x' }, authority: { score: -3, note: 'y' }, need: { score: 12.6, note: 'z' }, timeline: { score: 25, note: 'w' } }, reasoning: 'r' });
  const r = await runAgent(2, 'score_lead', { leadId: 20 });
  assert.equal(r.score, 25 + 0 + 13 + 25);
});

test('a malformed breakdown is refused and the stored score is left alone', async () => {
  db.prepare('UPDATE leads SET score = 51 WHERE id = 20').run();
  scoreAs({ bant: { budget: { score: 'high' } }, reasoning: 'r' });
  await assert.rejects(runAgent(2, 'score_lead', { leadId: 20 }), /malformed/);
  assert.equal(db.prepare('SELECT score FROM leads WHERE id = 20').get().score, 51);
});

test('qualifying a lead stores the same breakdown', async () => {
  scoreAs({ qualified: true, bant_score: { budget: 20, authority: 21, need: 22, timeline: 18 }, total_score: 81, qualification_notes: 'Clear need with a deadline.', next_steps: ['Book a call'] });
  await runAgent(2, 'qualify_lead', { leadId: 20 });
  const detail = JSON.parse(db.prepare('SELECT score_detail FROM leads WHERE id = 20').get().score_detail);
  assert.equal(detail.bant.timeline.score, 18);
  assert.equal(detail.next_step, 'Book a call');
  assert.equal(db.prepare('SELECT score FROM leads WHERE id = 20').get().score, 81);
});

async function as(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business' }; next(); });
  app.use('/api/leads', leadsRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  try { await fn(get); } finally { s.close(); }
}

test('"why this score" shows the breakdown with the signals and sources it came from, to the owner only', async () => {
  scoreAs({ bant: BANT, reasoning: 'Strong fit.', recommended_action: 'Send this week.' });
  await runAgent(2, 'score_lead', { leadId: 20 });
  await as(2, async (get) => {
    const r = await get('/api/leads/20/score-detail');
    assert.equal(r.status, 200);
    assert.equal(r.body.score, 88);
    assert.equal(r.body.bant.authority.score, 24);
    assert.ok(r.body.signals.some(s => /second plant/i.test(s.text)), 'buying signal listed');
    assert.ok(r.body.sources.includes('https://news.example/velora-plant'), 'verification sources listed');
    assert.equal(r.body.name, 'Lee Shu Fen', 'names are shown in full; only email and phone are masked');
    assert.equal(r.body.email, undefined, 'no contact details in the score view');
    assert.equal((await get('/api/leads/30/score-detail')).status, 404);
  });
});

test('lead lists show full names but keep email and phone masked', async () => {
  await as(2, async (get) => {
    const r = await get('/api/leads/20');
    assert.equal(r.body.name, 'Lee Shu Fen');
    assert.notEqual(r.body.email, 'shufen@velora.example');
    assert.equal(r.body._masked, true);
  });
});
