import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { JSDOM } from 'jsdom';

// LinkedIn takes at most 200 characters in a connection note (the 300 we used
// was Premium's limit). Notes are written to fit, cut back on whole sentences
// when they don't, and the team records a note they sent from their own
// account, which moves the lead from New to Contacted.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-li200-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { fitLinkedinNote, LINKEDIN_NOTE_MAX } = await import('../src/utils/linkedin-note.js');
const { fitUnsentLinkedinNotes } = await import('../src/db/schema-outreach.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');
const { editDraft, markLinkedinSent, recordLinkedinNoteSent } = await import('../src/services/outreach-queue.js');
const { default: leadsRouter } = await import('../src/routes/leads.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'ai_cost_log', 'agent_tasks', 'leads', 'campaigns', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  for (const id of [2, 3]) {
    db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `o${id}@example.com`);
  }
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer) VALUES (2, 'EIAAW Solutions', 'Amos', 'AI agents for Malaysian manufacturers')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, company, status, linkedin_url) VALUES (20, 2, 'Che Fai', 'Kulim Robotics', 'new', 'https://www.linkedin.com/in/che-fai')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, company, status) VALUES (21, 2, 'Nurul Huda', 'Seri Andalas', 'qualified')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, company, status) VALUES (30, 3, 'Other Tenant', 'Elsewhere', 'new')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject) VALUES (50, 2, 'Q4', 'email', 'active', 'Hi')").run();
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject) VALUES (60, 3, 'Theirs', 'email', 'active', 'Hi')").run();
  agent.resetChat();
});

const queue = (campaignId, leadId, channel, status, message) => db.prepare(
  'INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, user_id) VALUES (?, ?, 2, ?, ?, ?, ?)'
).run(campaignId, leadId, channel, message, status, campaignId === 60 ? 3 : 2).lastInsertRowid;
const item = (id) => db.prepare('SELECT * FROM outreach_queue WHERE id = ?').get(id);
const lead = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

// The note on screen on 29 Oct 2026: 224 characters, written for the old 300.
const SCREENSHOT = "Hi Che Fai, saw your posts on AI and robotics integration — fascinating space. I'm building AI agents for Malaysian manufacturers handling sales, HR, and ops. Would love to connect and exchange ideas. — Amos, EIAAW Solutions";

test('the limit is 200', () => {
  assert.equal(LINKEDIN_NOTE_MAX, 200);
  assert.equal(SCREENSHOT.length, 224);
});

test('an over-long note loses its sign-off first — LinkedIn already shows who sent it', () => {
  const note = fitLinkedinNote(SCREENSHOT);
  assert.ok(note.length <= 200, `${note.length} characters`);
  assert.ok(note.startsWith('Hi Che Fai, saw your posts'));
  assert.ok(note.endsWith('Would love to connect and exchange ideas.'), note);
});

test('then middle sentences go, keeping the opening and the closing ask', () => {
  const note = fitLinkedinNote('Hi Che Fai, saw your talk on robotics at the Penang summit last week. We build AI agents that handle sales follow-ups and HR paperwork for factories. Two Kulim plants already run them every day across three shifts. Open to connecting?');
  assert.ok(note.length <= 200, `${note.length} characters`);
  assert.ok(note.startsWith('Hi Che Fai, saw your talk'));
  assert.ok(note.endsWith('Open to connecting?'), note);
  assert.doesNotMatch(note, /\s{2}/);
});

test('one very long sentence is cut on a word, never mid-word, and links never survive', () => {
  const note = fitLinkedinNote(`Hi Che Fai ${'and robotics '.repeat(30)}https://eiaaw.example/x {{CALL_LINK}}`);
  assert.ok(note.length <= 200);
  assert.ok(/robotics$|and$/.test(note), note);
  assert.doesNotMatch(note, /https?:|CALL_LINK/);
  assert.equal(fitLinkedinNote('Short and fine. — Amos'), 'Short and fine. — Amos');
});

test('every prompt that writes a note asks for about 180 characters, not 300', async () => {
  const prompts = [];
  agent.setChat(async (m) => { prompts.push(m); return JSON.stringify({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: SCREENSHOT }] }); });
  const r = await runAgent(2, 'craft_outreach', { leadId: 20 });
  assert.ok(r.sequence[0].message.length <= 200);

  db.prepare('INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, 20)').run();
  agent.setChat(async (m) => { prompts.push(m); return JSON.stringify({ sequences: [] }); });
  await runAgent(2, 'auto_outreach', { campaignId: 50 }).catch(() => {}); // only the prompt matters here

  const draft = queue(50, 20, 'linkedin', 'draft', SCREENSHOT);
  agent.setChat(async (m) => { prompts.push(m); return JSON.stringify({ message: 'Hi Che Fai, keen to connect. Amos' }); });
  await runAgent(2, 'rewrite_outreach', { itemId: draft, length: 'shorter', campaignId: 50 });

  assert.equal(prompts.length, 3);
  for (const p of prompts) {
    assert.match(p, /180 characters/);
    assert.match(p, /200/);
    assert.doesNotMatch(p, /300 characters/);
  }
});

test('notes waiting to be sent are cut to 200 once; sent notes and emails are left alone', () => {
  const long = queue(50, 20, 'linkedin', 'pending', SCREENSHOT);
  const draft = queue(50, 21, 'linkedin', 'draft', SCREENSHOT);
  const sent = queue(50, 21, 'linkedin', 'sent', SCREENSHOT);
  const email = queue(50, 20, 'email', 'pending', 'x'.repeat(400));
  assert.equal(fitUnsentLinkedinNotes(db), 2);
  assert.equal(item(long).message, fitLinkedinNote(SCREENSHOT));
  assert.equal(item(draft).message, fitLinkedinNote(SCREENSHOT));
  assert.equal(item(sent).message, SCREENSHOT);
  assert.equal(item(email).message.length, 400);
  assert.equal(fitUnsentLinkedinNotes(db), 0, 'nothing left to do on the next boot');
});

test('a note edited by hand must fit in 200; an email can be any length', () => {
  const note = queue(50, 20, 'linkedin', 'draft', 'Hi');
  const email = queue(50, 20, 'email', 'draft', 'Hi');
  assert.equal(editDraft({ campaignId: 50, itemId: note, message: 'x'.repeat(201) }), 'too_long');
  assert.equal(item(note).message, 'Hi');
  assert.equal(editDraft({ campaignId: 50, itemId: note, message: 'x'.repeat(200) }), 'ok');
  assert.equal(editDraft({ campaignId: 50, itemId: email, message: 'x'.repeat(900) }), 'ok');
});

test('marking a queued note sent moves a New lead to Contacted, never a lead further along', () => {
  const a = queue(50, 20, 'linkedin', 'pending', 'Hi Che Fai');
  const b = queue(50, 21, 'linkedin', 'pending', 'Hi Nurul');
  assert.equal(markLinkedinSent({ campaignId: 50, itemId: a, by: 2 }), 'ok');
  assert.equal(markLinkedinSent({ campaignId: 50, itemId: b, by: 2 }), 'ok');
  assert.equal(lead(20).status, 'contacted');
  assert.equal(lead(21).status, 'qualified');
});

test("a note sent from the outreach window is logged with its text, the lead moves to Contacted, and the campaign's note is closed", () => {
  const open = queue(50, 20, 'linkedin', 'pending', 'The campaign draft');
  const theirs = queue(60, 30, 'linkedin', 'pending', 'Another account');
  const note = fitLinkedinNote(SCREENSHOT);
  const r = recordLinkedinNoteSent({ userId: 2, leadId: 20, message: note, by: 2 });
  assert.equal(r.already, false);
  assert.equal(lead(20).status, 'contacted');
  const acts = db.prepare("SELECT * FROM activities WHERE lead_id = 20 AND type = 'note'").all();
  assert.equal(acts.length, 1);
  assert.ok(acts[0].description.includes(note));
  assert.equal(acts[0].user_id, 2);
  assert.equal(item(open).status, 'sent');
  assert.equal(item(open).message, note, 'the queue shows what was really sent');
  assert.equal(item(theirs).status, 'pending');

  const again = recordLinkedinNoteSent({ userId: 2, leadId: 20, message: note, by: 2 });
  assert.equal(again.already, true, 'LinkedIn takes one invitation per person');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activities WHERE lead_id = 20 AND type = 'note'").get().c, 1);
});

async function withLeadRoutes(userId, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: userId, role: 'user', plan: 'business' }; next(); });
  app.use('/api/leads', leadsRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try { await fn(call); } finally { s.close(); }
}

test("the route records the note only on the account's own lead", async () => {
  await withLeadRoutes(2, async (call) => {
    assert.equal((await call('/api/leads/30/linkedin-note-sent', { message: 'Hi' })).status, 404);
    assert.equal((await call('/api/leads/20/linkedin-note-sent', { message: '  ' })).status, 400);
    const r = await call('/api/leads/20/linkedin-note-sent', { message: 'Hi Che Fai, keen to connect. Amos' });
    assert.equal(r.status, 200);
    assert.equal(r.body.already, false);
  });
  assert.equal(lead(30).status, 'new');
  assert.equal(lead(20).status, 'contacted');
});

// The outreach window and the approval queue (public/app.js).
const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = (name, prefix = 'function') => { const i = src.indexOf(`${prefix} ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };

async function outreachWindow(result, answer = { ok: true, already: false }) {
  const ctx = {
    posts: [], notes: [], shown: null, refreshed: [],
    api: { post: async (p, body) => { if (p.endsWith('/outreach')) return result; ctx.posts.push({ p, body }); return answer; } },
    showResultModal: (title, html) => { ctx.shown = { title, html }; ctx.doc = new JSDOM(html).window.document; ctx.document = ctx.doc; },
    showNotification: (msg, type) => { ctx.notes.push({ msg, type }); },
    refreshCampaignLeads(id) { ctx.refreshed.push(id); },
    navigator: { clipboard: { writeText: async () => {} } },
  };
  vm.createContext(ctx);
  vm.runInContext([
    'let lastOutreachSteps = []; let lastOutreachLead = null; let currentPage = "campaigns";', 'const LINKEDIN_NOTE_MAX = 200;',
    fn('esc'), fn('noteSentDay'), fn('linkedinNoteCount'), fn('aiOutreach', 'async function'), fn('linkedinNoteActions'),
    fn('copyOutreachStep', 'async function'), fn('markOutreachNoteSent', 'async function'),
  ].join('\n'), ctx);
  await ctx.aiOutreach(20, 50);
  return ctx;
}

test('the outreach window counts against 200 and has Mark as sent', async () => {
  const note = fitLinkedinNote(SCREENSHOT);
  const ctx = await outreachWindow({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: note }], linkedin_profile: 'https://www.linkedin.com/in/che-fai' });
  assert.match(ctx.doc.body.textContent, new RegExp(`${note.length} / 200 characters`));
  const btn = [...ctx.doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Mark as sent');
  assert.ok(btn, 'a Mark as sent button');
  ctx.refreshed = [];
  await vm.runInContext(btn.getAttribute('onclick'), ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.posts)), [{ p: '/leads/20/linkedin-note-sent', body: { message: note, campaignId: 50 } }]);
  assert.equal(btn.disabled, true);
  assert.match(btn.textContent, /Sent/);
  assert.match(ctx.notes.at(-1).msg, /Contacted/);
  assert.deepEqual([...ctx.refreshed], [50]);
});

test('a note already recorded says when, instead of logging it twice', async () => {
  const ctx = await outreachWindow({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: 'Hi' }], linkedin_profile: null }, { ok: true, already: true, sent_at: '2026-10-29 03:00:00' });
  const btn = [...ctx.doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Mark as sent');
  await vm.runInContext(btn.getAttribute('onclick'), ctx);
  assert.match(ctx.notes.at(-1).msg, /already/i);
  assert.equal(btn.disabled, true);
});

test('a note over 200 is flagged in red with what to do', () => {
  const ctx = { };
  vm.createContext(ctx);
  vm.runInContext(['const LINKEDIN_NOTE_MAX = 200;', fn('esc'), fn('linkedinNoteCount')].join('\n'), ctx);
  const over = new JSDOM(ctx.linkedinNoteCount('x'.repeat(263))).window.document.body;
  assert.match(over.textContent, /263 \/ 200 characters/);
  assert.match(over.textContent, /too long/i);
  assert.match(over.querySelector('span').getAttribute('style'), /--danger/);
  const ok = new JSDOM(ctx.linkedinNoteCount('x'.repeat(150))).window.document.body;
  assert.doesNotMatch(ok.textContent, /too long/i);
});
