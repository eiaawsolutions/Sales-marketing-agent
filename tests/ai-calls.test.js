import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

// What an AI call is allowed, and what it is logged as costing.
//
// A web-search call gets three minutes and is never re-sent by the SDK: a
// re-sent search is paid for again. On 28 Oct 2026 one press ran the lead
// search three times, 90 s each, and got nothing back.
//
// Cost is logged per task from that task's own calls, every one of them, even
// while other accounts' AI calls finish at the same time. A shared "last
// usage" logged a failed search with another account's lead score instead.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-aicalls-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'leads', 'campaigns', 'account_profiles', 'ai_cost_log', 'agent_tasks', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `o${id}@example.com`);
  }
  db.prepare("INSERT INTO leads (id, user_id, name, email, company) VALUES (30, 3, 'Farhana Aziz', 'farhana@kilang.example', 'Kilang')").run();
  for (const k of ['CRAWL4AI_URL', 'CRAWL4AI_API_TOKEN', 'REACHER_URL']) delete process.env[k];
  globalThis.fetch = realFetch;
  agent.resetChat();
});

const SEARCH = { targetAudience: 'HR Directors in Malaysia', campaignName: 'x', count: 5 };
const isSearch = (message) => message.includes('lead generation and verification engine');
const SEARCH_USAGE = { inputTokens: 81094, outputTokens: 4178, webSearchRequests: 4 };
const SCORE_USAGE = { inputTokens: 3423, outputTokens: 599, webSearchRequests: 0 };
const usageOf = (message) => (isSearch(message) ? SEARCH_USAGE : SCORE_USAGE);
const scoreReply = JSON.stringify({
  bant: Object.fromEntries(['budget', 'authority', 'need', 'timeline'].map(f => [f, { score: 10, note: 'no evidence found' }])),
  reasoning: 'Fits the market.', recommended_action: 'Send the first email.',
});
const costRows = () => db.prepare('SELECT user_id, task_type, input_tokens, output_tokens, web_search_requests FROM ai_cost_log ORDER BY id').all()
  .map(r => ({ ...r }));

function gate() { let open; const p = new Promise(r => { open = r; }); return { p, open }; }

// A stand-in for the Anthropic client: records each request and its options.
function fakeClient(reply = () => ({ text: '{"leads":[]}' })) {
  const calls = [];
  agent.setClient({
    messages: {
      async create(body, options) {
        calls.push({ body, options });
        const r = await reply(body);
        return {
          model: 'claude-test',
          usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: body.tools ? 2 : 0 } },
          content: [{ type: 'text', text: r.text }],
        };
      },
    },
  });
  return calls;
}

test('a web-search call gets three minutes and the SDK never re-sends it', async () => {
  const calls = fakeClient();
  await runAgent(2, 'generate_leads', SEARCH);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tools[0].name, 'web_search');
  assert.deepEqual(calls[0].options, { timeout: 180_000, maxRetries: 0 });
});

test('other AI calls keep the client defaults', async () => {
  const calls = fakeClient(() => ({ text: scoreReply }));
  await runAgent(3, 'score_lead', { leadId: 30 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options, undefined);
});

test('a search that times out is sent once, and no cost is made up for it', async () => {
  const calls = fakeClient(() => { throw new Anthropic.APIConnectionTimeoutError(); });
  await assert.rejects(runAgent(2, 'generate_leads', SEARCH), /Request timed out/);
  assert.equal(calls.length, 1);
  assert.deepEqual(costRows(), []);
});

test("a failed search is never logged with another account's AI usage", async () => {
  const g = gate();
  agent.setChat(async (message) => {
    if (isSearch(message)) { await g.p; throw new Error('Request timed out.'); }
    return scoreReply;
  }, usageOf);
  const search = runAgent(2, 'generate_leads', SEARCH);
  await runAgent(3, 'score_lead', { leadId: 30 });
  g.open();
  await assert.rejects(search, /Request timed out/);
  assert.deepEqual(costRows(), [
    { user_id: 3, task_type: 'score_lead', input_tokens: 3423, output_tokens: 599, web_search_requests: 0 },
  ]);
});

test('a search logs its own cost even when other AI calls finish while it reads company websites', async () => {
  process.env.CRAWL4AI_URL = 'http://crawl4ai.railway.internal:11235';
  process.env.CRAWL4AI_API_TOKEN = 'test-token';
  const reading = gate();
  const release = gate();
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(process.env.CRAWL4AI_URL)) return realFetch(url, init);
    reading.open();
    await release.p;
    return new Response(JSON.stringify({ markdown: 'Velora. Contact info@velora.example' }), { status: 200 });
  };
  agent.setChat(async (message) => (isSearch(message)
    ? JSON.stringify({ leads: [{
      name: 'Lee Shu Fen', type: 'B2B', title: 'Director, L&D', company: 'Velora', geography: 'Kulim', lead_type: 'Cold', email: '',
      linkedin_url: 'https://www.linkedin.com/in/example', company_website: 'https://velora.example',
      verification_sources: ['https://velora.example/team'], reason_for_fit: 'Owns L&D', confidence_score: 'High', source: 'ai_generated',
    }] })
    : scoreReply), usageOf);
  const search = runAgent(2, 'generate_leads', SEARCH);
  await reading.p;
  await runAgent(3, 'score_lead', { leadId: 30 });
  release.open();
  await search;
  assert.deepEqual(costRows(), [
    { user_id: 3, task_type: 'score_lead', input_tokens: 3423, output_tokens: 599, web_search_requests: 0 },
    { user_id: 2, task_type: 'generate_leads', input_tokens: 81094, output_tokens: 4178, web_search_requests: 4 },
  ]);
});

test('a task that makes several AI calls is logged with all of them', async () => {
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer) VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject) VALUES (50, 2, 'Q4', 'email', 'active', 'Hi')").run();
  for (let i = 0; i < 4; i++) {
    db.prepare('INSERT INTO leads (id, user_id, name, email, company) VALUES (?, 2, ?, ?, ?)').run(40 + i, `Lead ${i}`, `lead${i}@co${i}.example`, `Co ${i}`);
    db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, ?)').run(40 + i);
  }
  let calls = 0;
  agent.setChat(async () => { calls++; return '{"sequences":[]}'; }, () => ({ inputTokens: 1000, outputTokens: 100, webSearchRequests: 0 }));
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  assert.equal(calls, 2); // leads go three to a call
  assert.deepEqual(costRows(), [
    { user_id: 2, task_type: 'auto_outreach', input_tokens: 2000, output_tokens: 200, web_search_requests: 0 },
  ]);
});
