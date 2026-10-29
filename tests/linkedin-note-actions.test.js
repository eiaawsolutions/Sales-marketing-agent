import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// A one-off outreach sequence for a lead (the "AI Outreach Sequence" window).
// Its LinkedIn note is sent by the user from their own account, so the window
// gives the note and the lead's profile one click apart: copy the note, open
// the profile, paste it into Connect → Add a note.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-linote-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { runAgent, __testing: agent } = await import('../src/services/ai-agent.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['activities', 'ai_cost_log', 'agent_tasks', 'leads', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'amos', 'amos@example.com', 'x', 'user', 'active', 'business')").run();
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer) VALUES (2, 'EIAAW Solutions', 'Amos', 'AI that takes repetitive work off teams')").run();
  agent.resetChat();
});

const NOTE = 'Hi Foong Pon, fellow Malaysian AI builder here. Would love to connect and swap notes. - Amos';
function lead(id, { email = '', linkedin_url = null, notes = '' } = {}) {
  db.prepare('INSERT INTO leads (id, user_id, name, email, company, title, linkedin_url, notes) VALUES (?, 2, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Foong Pon', email || null, 'Elyxia Digital', 'Solutions Architect', linkedin_url, notes);
}
const reply = (steps) => agent.setChat(async () => JSON.stringify({ sequence: steps }));

test("the sequence comes with the lead's own LinkedIn profile as a clean link", async () => {
  lead(30, { linkedin_url: 'https://my.linkedin.com/in/Foong-Pon/?trk=public', notes: 'Profile: https://my.linkedin.com/in/Foong-Pon/' });
  reply([{ step: 1, channel: 'linkedin', delay_days: 0, message: NOTE, goal: 'connect' }]);
  const r = await runAgent(2, 'craft_outreach', { leadId: 30 });
  assert.equal(r.linkedin_profile, 'https://www.linkedin.com/in/foong-pon');
  assert.equal(r.sequence[0].message, NOTE);
});

test('the profile is found from the verified notes when the column is empty', async () => {
  lead(31, { notes: 'Fit: architect\nProfile: https://www.linkedin.com/in/foong-pon-123' });
  reply([{ step: 1, channel: 'linkedin', delay_days: 0, message: NOTE }]);
  assert.equal((await runAgent(2, 'craft_outreach', { leadId: 31 })).linkedin_profile, 'https://www.linkedin.com/in/foong-pon-123');
});

test('no profile link for a company page, or for anything that is not a LinkedIn profile', async () => {
  lead(32, { linkedin_url: 'https://www.linkedin.com/company/elyxia' });
  lead(33, { linkedin_url: 'javascript:alert(1)//linkedin.com/in/x' });
  reply([{ step: 1, channel: 'linkedin', delay_days: 0, message: NOTE }]);
  assert.equal((await runAgent(2, 'craft_outreach', { leadId: 32 })).linkedin_profile, null);
  assert.equal((await runAgent(2, 'craft_outreach', { leadId: 33 })).linkedin_profile, null);
});

test("a LinkedIn note is cut to LinkedIn's 300 characters; emails are left as written", async () => {
  lead(34, { email: 'foong@elyxia.example', linkedin_url: 'https://www.linkedin.com/in/foong-pon' });
  const longNote = `${'We build AI agents for Malaysian teams. '.repeat(12)}Would love to connect.`;
  const longEmail = 'A long email body. '.repeat(40);
  reply([
    { step: 1, channel: 'email', delay_days: 0, subject: 'Hi', message: longEmail },
    { step: 2, channel: 'linkedin', delay_days: 1, message: longNote },
  ]);
  const r = await runAgent(2, 'craft_outreach', { leadId: 34 });
  assert.ok(r.sequence[1].message.length <= 300, `note is ${r.sequence[1].message.length} characters`);
  assert.equal(r.sequence[0].message, longEmail);
});

// The window (public/app.js), with the page's helpers stubbed.
async function windowFor(result) {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = (name, prefix = 'function') => { const i = src.indexOf(`${prefix} ${name}(`); return src.slice(i, src.indexOf('\n}\n', i) + 3); };
  const ctx = {
    copied: [], notes: [], shown: null,
    api: { post: async () => result },
    showResultModal: (title, html) => { ctx.shown = { title, html }; },
    showNotification: (msg, type) => { ctx.notes.push({ msg, type }); },
    refreshCampaignLeads() {},
    navigator: { clipboard: { writeText: async (t) => { ctx.copied.push(t); } } },
  };
  vm.createContext(ctx);
  vm.runInContext([
    'let lastOutreachSteps = [];', fn('esc'), fn('aiOutreach', 'async function'), fn('linkedinNoteActions'), fn('copyOutreachStep', 'async function'),
  ].join('\n'), ctx);
  await ctx.aiOutreach(30);
  return { ctx, doc: new JSDOM(ctx.shown.html).window.document };
}

test('the LinkedIn note has one button that copies it and opens their profile in a new tab', async () => {
  const { ctx, doc } = await windowFor({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: NOTE }], linkedin_profile: 'https://www.linkedin.com/in/foong-pon' });
  const open = [...doc.querySelectorAll('a')].find(a => /open profile/i.test(a.textContent));
  assert.ok(open, 'a "Copy note & open profile" link');
  assert.equal(open.getAttribute('href'), 'https://www.linkedin.com/in/foong-pon');
  assert.equal(open.getAttribute('target'), '_blank');
  assert.match(open.getAttribute('rel'), /noopener/);
  await vm.runInContext(open.getAttribute('onclick'), ctx);
  assert.deepEqual([...ctx.copied], [NOTE]);
  assert.match(doc.body.textContent, /Connect.*Add a note.*paste/i);

  const copy = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Copy note');
  await vm.runInContext(copy.getAttribute('onclick'), ctx);
  assert.equal(ctx.copied.length, 2);
});

test('without a profile on file the note can still be copied, and the window says why there is no link', async () => {
  const { doc } = await windowFor({ sequence: [{ step: 1, channel: 'linkedin', delay_days: 0, message: NOTE }], linkedin_profile: null });
  assert.equal(doc.querySelectorAll('a').length, 0);
  assert.ok([...doc.querySelectorAll('button')].some(b => b.textContent.trim() === 'Copy note'));
  assert.match(doc.body.textContent, /no LinkedIn profile on file/i);
});

test('email steps get no LinkedIn buttons', async () => {
  const { doc } = await windowFor({ sequence: [{ step: 1, channel: 'email', delay_days: 0, subject: 'Hi', message: 'Hello' }], linkedin_profile: 'https://www.linkedin.com/in/foong-pon' });
  assert.equal(doc.querySelectorAll('a, button').length, 0);
});
