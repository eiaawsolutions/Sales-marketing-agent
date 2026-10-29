import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { JSDOM } from 'jsdom';

// A campaign's lead list shows each lead's status in that campaign
// (campaign_leads.status), which only the email sender moved on. On 29 Oct
// 2026 a LinkedIn note marked sent left Che Fai at "pending" there, so it
// looked as if Mark as sent did nothing. A note marked sent now counts as the
// campaign's send, and a window reopened for a lead already invited says so.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-li-camp-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { markLinkedinNotesSentInCampaigns } = await import('../src/db/schema-outreach.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { markLinkedinSent, recordLinkedinNoteSent } = await import('../src/services/outreach-queue.js');
const { default: leadsRouter } = await import('../src/routes/leads.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key = 'migration_linkedin_notes_sent_in_campaigns'").run();
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `o${id}@example.com`);
  }
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer) VALUES (2, 'EIAAW Solutions', 'Amos', 'AI agents for manufacturers')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, company, status, linkedin_url) VALUES (17, 2, 'Che Fai', 'DF Automation', 'new', 'https://www.linkedin.com/in/che-fai')").run();
  for (const [id, owner] of [[1, 2], [2, 2], [60, 3]]) {
    db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject) VALUES (?, ?, ?, 'email', 'active', 'Hi')").run(id, owner, `C${id}`);
  }
  agent.resetChat();
});

const inCampaign = (campaignId, status = 'pending') => db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (?, 17, ?)').run(campaignId, status);
const campaignStatus = (campaignId) => db.prepare('SELECT status, sent_at FROM campaign_leads WHERE campaign_id = ? AND lead_id = 17').get(campaignId);
const note = (campaignId, status) => db.prepare(
  "INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, user_id, sent_at) VALUES (?, 17, 1, 'linkedin', 'Hi Che Fai', ?, 2, ?)"
).run(campaignId, status, status === 'sent' ? '2026-10-29 15:47:38' : null).lastInsertRowid;

test('a queued note marked sent counts as the campaign having reached the lead', () => {
  inCampaign(1);
  const id = note(1, 'pending');
  assert.equal(markLinkedinSent({ campaignId: 1, itemId: id, by: 2 }), 'ok');
  assert.equal(campaignStatus(1).status, 'sent');
  assert.ok(campaignStatus(1).sent_at);
});

test('a lead who already opened or replied keeps that status', () => {
  inCampaign(1, 'opened');
  const id = note(1, 'pending');
  markLinkedinSent({ campaignId: 1, itemId: id, by: 2 });
  assert.equal(campaignStatus(1).status, 'opened');
});

test('a note sent from the outreach window marks the campaign it was opened from, and the campaign whose note it closed', () => {
  inCampaign(1);
  inCampaign(2);
  note(2, 'pending');
  recordLinkedinNoteSent({ userId: 2, leadId: 17, message: 'Hi Che Fai, keen to connect. Amos', by: 2, campaignId: 1 });
  assert.equal(campaignStatus(1).status, 'sent', 'the campaign the window was opened from');
  assert.equal(campaignStatus(2).status, 'sent', 'the campaign whose waiting note was closed');
});

test("another account's campaign is never touched, even when its id is sent", () => {
  inCampaign(60);
  recordLinkedinNoteSent({ userId: 2, leadId: 17, message: 'Hi', by: 2, campaignId: 60 });
  assert.equal(campaignStatus(60).status, 'pending');
});

test('Mark as sent on a note logged before this fix still puts the campaign right', () => {
  inCampaign(1);
  note(1, 'sent');
  db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (2, 17, 1, 'note', 'LinkedIn connection note sent from your own account')").run();
  const r = recordLinkedinNoteSent({ userId: 2, leadId: 17, message: 'Hi', by: 2, campaignId: 1 });
  assert.equal(r.already, true);
  assert.equal(campaignStatus(1).status, 'sent');
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = 17').get().status, 'contacted');
});

test('notes already marked sent are counted in their campaigns once at boot', () => {
  inCampaign(1);
  inCampaign(2, 'replied');
  note(1, 'sent');
  note(2, 'sent');
  assert.equal(markLinkedinNotesSentInCampaigns(db), 1);
  assert.deepEqual({ ...campaignStatus(1) }, { status: 'sent', sent_at: '2026-10-29 15:47:38' });
  assert.equal(campaignStatus(2).status, 'replied');
  db.prepare("UPDATE campaign_leads SET status = 'pending' WHERE campaign_id = 1").run();
  assert.equal(markLinkedinNotesSentInCampaigns(db), 0, 'runs once');
});

test("the outreach answer says when this lead's note was already sent", async () => {
  agent.setChat(async () => JSON.stringify({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: 'Hi Che Fai' }] }));
  assert.equal((await runAgent(2, 'craft_outreach', { leadId: 17 })).linkedin_note_sent_at, null);
  inCampaign(1);
  recordLinkedinNoteSent({ userId: 2, leadId: 17, message: 'Hi', by: 2, campaignId: 1 });
  assert.match(String((await runAgent(2, 'craft_outreach', { leadId: 17 })).linkedin_note_sent_at), /^\d{4}-\d{2}-\d{2}/);
});

test('the route passes on the campaign the window was opened from', async () => {
  inCampaign(1);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 2, role: 'user', plan: 'business' }; next(); });
  app.use('/api/leads', leadsRouter);
  const s = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/leads/17/linkedin-note-sent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Hi Che Fai', campaignId: 1 }),
    });
    assert.equal(r.status, 200);
  } finally { s.close(); }
  assert.equal(campaignStatus(1).status, 'sent');
});

// The outreach window (public/app.js).
const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = (name, prefix = 'function') => { const i = src.indexOf(`${prefix} ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };

async function outreachWindow(result) {
  const ctx = {
    posts: [], notes: [],
    api: { post: async (p, body) => { if (p.endsWith('/outreach')) return result; ctx.posts.push({ p, body }); return { ok: true, already: false }; } },
    showResultModal: (title, html) => { ctx.doc = new JSDOM(html).window.document; ctx.document = ctx.doc; },
    showNotification: (msg, type) => { ctx.notes.push({ msg, type }); },
    refreshCampaignLeads() {},
    navigator: { clipboard: { writeText: async () => {} } },
  };
  vm.createContext(ctx);
  vm.runInContext([
    'let lastOutreachSteps = []; let lastOutreachLead = null; let currentPage = "campaigns";', 'const LINKEDIN_NOTE_MAX = 200;',
    fn('esc'), fn('noteSentDay'), fn('linkedinNoteCount'), fn('aiOutreach', 'async function'), fn('linkedinNoteActions'),
    fn('copyOutreachStep', 'async function'), fn('markOutreachNoteSent', 'async function'),
  ].join('\n'), ctx);
  await ctx.aiOutreach(17, 1);
  return ctx;
}

test('Mark as sent tells the server which campaign the window was opened from', async () => {
  const ctx = await outreachWindow({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: 'Hi Che Fai' }], linkedin_profile: null, linkedin_note_sent_at: null });
  const btn = [...ctx.doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Mark as sent');
  await vm.runInContext(btn.getAttribute('onclick'), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.posts)), [{ p: '/leads/17/linkedin-note-sent', body: { message: 'Hi Che Fai', campaignId: 1 } }]);
});

test('reopened for a lead already invited, the window shows the note as sent instead of offering Mark as sent', async () => {
  const ctx = await outreachWindow({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: 'Hi Che Fai' }], linkedin_profile: null, linkedin_note_sent_at: '2026-10-29 15:47:38' });
  const buttons = [...ctx.doc.querySelectorAll('button')];
  assert.ok(!buttons.some(b => b.textContent.trim() === 'Mark as sent'));
  const sent = buttons.find(b => /^Sent/.test(b.textContent.trim()));
  assert.ok(sent, 'a Sent button');
  assert.equal(sent.disabled, true);
  assert.match(ctx.doc.body.textContent, /30 Oct 2026|29 Oct 2026/);
  assert.match(ctx.doc.body.textContent, /one invitation per person/i);
});
