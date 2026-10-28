import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// A decision-maker the open web confirms but who publishes no email of their
// own is kept for the LinkedIn steps of a sequence, and only those. The proof
// is their LinkedIn profile, and it has to be one the web search itself
// returned, under their name: the model's word is not enough (on 28 Oct 2026
// it cited company websites that do not exist). They are stored with no
// email, never twice, and nothing tries to email them.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-lionly-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.OUTREACH_SEND_GAP_MS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { campaignsService } = await import('../src/services/campaigns.js');
const { default: leadsRouter } = await import('../src/routes/leads.js');

const realFetch = globalThis.fetch;
let sent = [];
after(() => { globalThis.fetch = realFetch; agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')").run();
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer) VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Leadership programmes for first-time managers')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (50, 2, 'TLL Q4', 'email', 'active', 'Hi', '<p>Hello</p>')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  for (const k of ['CRAWL4AI_URL', 'CRAWL4AI_API_TOKEN', 'REACHER_URL']) delete process.env[k];
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

const PROFILE = 'https://www.linkedin.com/in/shufen-lee-velora';
const RESULT = { url: 'https://my.linkedin.com/in/shufen-lee-velora/', title: 'Lee Shu Fen - Director, L&D - Velora | LinkedIn' };
const SEARCH = { campaignId: 50, targetAudience: 'HR Directors in Malaysia', campaignName: 'TLL Q4', count: 5 };

const person = (over = {}) => ({
  name: 'Lee Shu Fen', type: 'B2B', title: 'Director, L&D', company: 'Velora', geography: 'Kulim', lead_type: 'Cold',
  email: '', phone: '', other_contact: '', linkedin_url: PROFILE, company_website: '',
  verification_sources: [PROFILE], reason_for_fit: 'Owns L&D at a growing manufacturer', buying_signal: '',
  confidence_score: 'High', enrichment: '', source: 'ai_generated', ...over,
});

// One lead search whose web search returned `results`.
function search(leads, results = [RESULT]) {
  agent.setChat(async () => JSON.stringify({ leads }), (_m, options) => ({
    inputTokens: 0, outputTokens: 0, webSearchRequests: options.useWebSearch ? 1 : 0,
    searchResults: options.useWebSearch ? results : [],
  }));
  return runAgent(2, 'generate_leads', SEARCH);
}
const stored = () => db.prepare('SELECT * FROM leads WHERE user_id = 2 ORDER BY id').all();

test('a person with no public email is kept for LinkedIn when the search returned their profile under their name', async () => {
  const res = await search([person()]);
  assert.equal(res.generated, 1);
  assert.equal(res.linkedin_only, 1);
  const [lead] = stored();
  assert.equal(lead.email, null);
  assert.equal(lead.email_normalized, null);
  assert.equal(lead.linkedin_url, PROFILE);
  assert.equal(lead.linkedin_normalized, 'linkedin.com/in/shufen-lee-velora');
  assert.match(lead.notes, /Profile: https:\/\/www\.linkedin\.com\/in\/shufen-lee-velora/);
  assert.ok(db.prepare('SELECT 1 FROM campaign_leads WHERE campaign_id = 50 AND lead_id = ?').get(lead.id));
  assert.match(db.prepare('SELECT description FROM activities WHERE lead_id = ?').get(lead.id).description, /LinkedIn only/);
});

test('a LinkedIn profile the web search never returned is not enough', async () => {
  const res = await search([person()], [{ url: 'https://www.linkedin.com/in/someone-else', title: 'Someone Else | LinkedIn' }]);
  assert.equal(res.generated, 0);
  assert.match(res.rejectedLeads[0].reason, /no public email found, and the search did not return their LinkedIn profile/);
  assert.equal(stored().length, 0);
});

test('a profile in the results that does not carry their name is not enough', async () => {
  const res = await search([person()], [{ url: PROFILE, title: 'Velora Sdn Bhd | LinkedIn' }]);
  assert.equal(res.generated, 0);
  assert.match(res.rejectedLeads[0].reason, /the LinkedIn profile found does not name them/);
});

test("a company page is not a person's profile, and low confidence is still discarded", async () => {
  const company = 'https://www.linkedin.com/company/velora';
  const res = await search([
    person({ linkedin_url: company, verification_sources: [company] }),
    person({ name: 'Nurul Huda', confidence_score: 'Low' }),
  ], [{ url: company, title: 'Lee Shu Fen | Velora | LinkedIn' }, { url: PROFILE, title: 'Nurul Huda | LinkedIn' }]);
  assert.equal(res.generated, 0);
  assert.deepEqual(res.rejectedLeads.map(r => r.reason), ['no public email or LinkedIn profile found', 'low confidence']);
});

test('a team inbox is not their email: they are kept for LinkedIn and the inbox is not stored', async () => {
  process.env.REACHER_URL = 'http://reacher.railway.internal:8080';
  const fetchResend = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith(process.env.REACHER_URL)
    ? new Response(JSON.stringify({ input: 'hr@velora.example', is_reachable: 'safe', misc: {}, mx: { accepts_mail: true }, smtp: {} }), { status: 200 })
    : fetchResend(url, init));
  const res = await search([person({ email: 'hr@velora.example' })]);
  assert.equal(res.generated, 1);
  const [lead] = stored();
  assert.equal(lead.email, null);
  assert.doesNotMatch(lead.notes, /Mailbox check|hr@/, 'the notes say nothing about the inbox');
  assert.equal(res.leads[0].email, '');
});

test('the same person is stored once: in one search, and when found again', async () => {
  assert.equal((await search([person(), person({ linkedin_url: 'https://www.linkedin.com/in/ShuFen-Lee-Velora/' })])).generated, 1);
  const again = await search([person()]);
  assert.equal(again.generated, 0);
  assert.equal(again.reused, 1);
  assert.equal(stored().length, 1);
});

test('someone already in the list with an email is not added again as LinkedIn-only', async () => {
  db.prepare("INSERT INTO leads (id, user_id, name, email, email_normalized, notes) VALUES (20, 2, 'Lee Shu Fen', 'shufen.lee@velora.example', 'shufen.lee@velora.example', 'Profile: https://www.linkedin.com/in/shufen-lee-velora')").run();
  const res = await search([person()]);
  assert.equal(res.generated, 0);
  assert.equal(res.reused, 1);
  assert.deepEqual(stored().map(l => l.id), [20]);
  assert.ok(db.prepare('SELECT 1 FROM campaign_leads WHERE campaign_id = 50 AND lead_id = 20').get());
});

test("a LinkedIn link in another lead's notes is not that lead's profile", async () => {
  db.prepare("INSERT INTO leads (id, user_id, name, notes) VALUES (23, 2, 'Farhana Aziz', 'Verification: https://www.linkedin.com/in/shufen-lee-velora')").run();
  const res = await search([person({ email: 'shufen.lee@velora.example' })]);
  assert.equal(res.generated, 1);
  assert.deepEqual(stored().map(l => [l.name, l.email]), [['Farhana Aziz', null], ['Lee Shu Fen', 'shufen.lee@velora.example']]);
});

test('a LinkedIn-only lead found later with a public email gains it, in the same row', async () => {
  await search([person()]);
  const res = await search([person({ email: 'shufen.lee@velora.example' })]);
  assert.equal(res.generated, 0);
  assert.equal(res.reused, 1);
  const rows = stored();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'shufen.lee@velora.example');
  assert.equal(rows[0].email_normalized, 'shufen.lee@velora.example');
});

test('an email lead keeps its LinkedIn profile as a key only when the search returned it', async () => {
  await search([
    person({ email: 'shufen.lee@velora.example' }),
    person({ name: 'Nurul Huda', email: 'nurul@seri.example', linkedin_url: 'https://www.linkedin.com/in/nurul-huda' }),
  ]);
  const rows = stored();
  assert.deepEqual(rows.map(l => [l.email, l.linkedin_normalized]), [
    ['shufen.lee@velora.example', 'linkedin.com/in/shufen-lee-velora'],
    ['nurul@seri.example', null],
  ]);
});

test('the profiles come from the web search results in the API response', async () => {
  agent.setClient({
    messages: {
      async create() {
        return {
          model: 'claude-test',
          usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 2 } },
          content: [
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'Velora L&D director LinkedIn' } },
            { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [
              { type: 'web_search_result', url: RESULT.url, title: RESULT.title, encrypted_content: 'x', page_age: null },
            ] },
            { type: 'server_tool_use', id: 'srv_2', name: 'web_search', input: { query: 'Velora team' } },
            { type: 'web_search_tool_result', tool_use_id: 'srv_2', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } },
            { type: 'text', text: JSON.stringify({ leads: [person()] }) },
          ],
        };
      },
    },
  });
  const res = await runAgent(2, 'generate_leads', SEARCH);
  assert.equal(res.generated, 1);
});

test('the search prompt says when a person with no email can be returned', async () => {
  let prompt = '';
  agent.setChat(async (m) => { prompt = m; return '{"leads":[]}'; });
  await runAgent(2, 'generate_leads', SEARCH);
  assert.match(prompt, /their personal LinkedIn profile \(linkedin\.com\/in\/\.\.\.\) appeared in your search results/);
  assert.match(prompt, /NEVER construct a LinkedIn URL/);
});

test('a lead with no email gets one LinkedIn note on day 0, whatever the model returns', async () => {
  await search([person()]);
  const id = stored()[0].id;
  let prompt = '';
  agent.setChat(async (m) => {
    prompt = m;
    return JSON.stringify({ sequences: [{ lead_name: 'Lee Shu Fen', steps: [
      { step: 1, channel: 'email', delay_days: 0, subject: 'Kulim', message: 'Hi {{CALL_LINK}}', goal: 'open' },
      { step: 2, channel: 'linkedin', delay_days: 1, message: 'Hi Shu Fen, would like to connect. Aaron', goal: 'connect' },
      { step: 3, channel: 'linkedin', delay_days: 4, message: 'A second note', goal: 'nudge' },
      { step: 4, channel: 'email', delay_days: 3, subject: 'A checklist', message: 'Following up. {{CALL_LINK}}', goal: 'nudge' },
    ] }] });
  });
  const r = await runAgent(2, 'auto_outreach', { campaignId: 50 });
  assert.match(prompt, /"has_email":false/);
  assert.match(prompt, /has_email is false/);
  assert.deepEqual(db.prepare('SELECT step, channel, delay_days, message FROM outreach_queue WHERE lead_id = ?').all(id).map(s => ({ ...s })),
    [{ step: 1, channel: 'linkedin', delay_days: 0, message: 'Hi Shu Fen, would like to connect. Aaron' }]);
  assert.equal(r.summary[0].firstAction, 'linkedin');
});

test('a lead with neither an email nor a LinkedIn profile gets no sequence', async () => {
  db.prepare("INSERT INTO leads (id, user_id, name, phone) VALUES (21, 2, 'Phone Only', '+60123456789')").run();
  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, 21)').run();
  agent.setChat(async () => JSON.stringify({ sequences: [{ lead_name: 'Phone Only', steps: [
    { step: 1, channel: 'email', delay_days: 0, subject: 'Hi', message: 'Hi {{CALL_LINK}}', goal: 'open' },
  ] }] }));
  await runAgent(2, 'auto_outreach', { campaignId: 50 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM outreach_queue').get().c, 0);
});

test('sending a campaign skips leads with no email instead of marking them bounced', async () => {
  await search([person()]);
  const linkedinOnly = stored()[0].id;
  db.prepare("INSERT INTO leads (user_id, name, email) VALUES (2, 'Nurul Huda', 'nurul@seri.example')").run();
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id) SELECT 50, id FROM leads WHERE name = 'Nurul Huda'").run();
  const r = await campaignsService.sendCampaign(2, 50);
  assert.equal(r.sent, 1);
  assert.equal(r.no_email, 1);
  assert.deepEqual(sent.map(m => m.to[0]), ['nurul@seri.example']);
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE lead_id = ?').get(linkedinOnly).status, 'pending');
});

test('a contact reveal with nothing to reveal is refused and uses no credit', async () => {
  await search([person()]);
  const id = stored()[0].id;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 2, role: 'user', plan: 'business' }; next(); });
  app.use('/api/leads', leadsRouter);
  const s = app.listen(0);
  try {
    const r = await realFetch(`http://127.0.0.1:${s.address().port}/api/leads/${id}/reveal`, { method: 'POST' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /no email or phone/);
  } finally { s.close(); }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activities WHERE description LIKE 'Contact revealed:%'").get().c, 0);
});
