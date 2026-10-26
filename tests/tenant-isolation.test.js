import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// One account must never read, launch or write into another account's
// campaigns, deals or activity — including through the AI features, which
// build their prompts from the database.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-tenant-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { default: campaignsRouter } = await import('../src/routes/campaigns.js');
const { default: pipelineRouter } = await import('../src/routes/pipeline.js');
const { default: agentRouter } = await import('../src/routes/agent.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

function reset() {
  for (const t of ['outreach_queue', 'campaign_leads', 'pipeline', 'activities', 'leads', 'campaigns', 'ai_cost_log', 'agent_tasks', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  for (const id of [1, 2]) {
    db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')`)
      .run(id, `user${id}`, `owner${id}@example.com`);
  }
  // Account 1's private data.
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (10, 1, 'Alice Foreign', 'alice@foreign.example', 'Foreign Sdn Bhd')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (100, 1, 'Secret Campaign', 'email', 'draft', 'Hi', '<p>x</p>')").run();
  db.prepare("INSERT INTO pipeline (id, user_id, lead_id, stage, deal_value) VALUES (1000, 1, 10, 'proposal', 99999)").run();
  db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (1, 10, 'note', 'Alice private note about budget')").run();
  // Account 2's own data.
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (20, 2, 'Bob Own', 'bob@own.example', 'Own Sdn Bhd')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (200, 2, 'Own Campaign', 'email', 'draft', 'Hi', '<p>x</p>')").run();
  db.prepare("INSERT INTO pipeline (id, user_id, lead_id, stage, deal_value) VALUES (2000, 2, 20, 'qualification', 5000)").run();
}
beforeEach(reset);

async function as(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business', email: `owner${userId}@example.com` }; next(); });
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/agent', agentRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  try { await fn(call); } finally { server.close(); }
}

test("another account's campaign cannot be launched, polled, queued or drafted for", async () => {
  await as(2, async (call) => {
    assert.equal((await call('POST', '/api/campaigns/100/launch')).status, 404);
    assert.equal((await call('GET', '/api/campaigns/100/pipeline-status')).status, 404);
    assert.equal((await call('GET', '/api/campaigns/100/outreach-queue')).status, 404);
    assert.equal((await call('POST', '/api/campaigns/100/auto-outreach')).status, 404);
    assert.equal((await call('POST', '/api/campaigns/100/send')).status, 404);
    assert.equal((await call('POST', '/api/campaigns/100/leads', { leadIds: [20] })).status, 404);
  });
  assert.equal(db.prepare('SELECT pipeline_status FROM campaigns WHERE id = 100').get().pipeline_status, 'idle');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM campaign_leads WHERE campaign_id = 100').get().c, 0);
});

test("another account's leads cannot be attached to your own campaign", async () => {
  await as(2, async (call) => {
    const res = await call('POST', '/api/campaigns/200/leads', { leadIds: [10] });
    assert.equal(res.status, 400);
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM campaign_leads WHERE lead_id = 10').get().c, 0);
});

test('the owner still reaches their own campaign', async () => {
  await as(2, async (call) => {
    assert.equal((await call('GET', '/api/campaigns/200/pipeline-status')).status, 200);
    assert.equal((await call('POST', '/api/campaigns/200/leads', { leadIds: [20] })).status, 200);
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM campaign_leads WHERE campaign_id = 200').get().c, 1);
});

test("a deal cannot be opened on another account's lead", async () => {
  await as(2, async (call) => {
    const res = await call('POST', '/api/pipeline', { lead_id: 10, stage: 'prospecting' });
    assert.equal(res.status, 404);
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pipeline WHERE lead_id = 10').get().c, 1);
});

test('pipeline review only sees and returns your own deals', async () => {
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return '{"health_score":50,"bottlenecks":[],"recommendations":[],"forecast":{},"priority_deals":[]}'; });
  await as(2, async (call) => {
    const res = await call('POST', '/api/pipeline/analyze');
    assert.equal(res.status, 200);
    assert.equal(res.body.pipeline_summary.total_deals, 1);
    assert.equal(res.body.pipeline_summary.total_value, 5000);
  });
  assert.doesNotMatch(prompt, /Alice|Foreign|99999/);
  assert.match(prompt, /Bob Own/);
});

test("suggested actions never read another account's activity or deals", async () => {
  let prompt = '';
  agent.setChat(async (message) => { prompt = message; return '{"actions":[]}'; });
  await as(2, async (call) => {
    assert.equal((await call('POST', '/api/agent/suggest-actions', {})).status, 200);
    assert.equal((await call('POST', '/api/agent/suggest-actions', { leadId: 10 })).status, 404);
  });
  assert.doesNotMatch(prompt, /Alice|Foreign|private note/);
});
