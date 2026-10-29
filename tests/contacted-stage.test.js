import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A lead someone has written to is Contacted, however the email went out: a
// step of its sequence or the campaign email itself. The board, the pipeline
// review and the Monday brief all read the stage, so a lead that was emailed
// but left at New showed up as "untouched, zero contact made".
const dir = mkdtempSync(path.join(tmpdir(), 'sa-contacted-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.OUTREACH_SEND_GAP_MS = '0';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { processOutreachQueue } = await import('../src/services/outreach-dispatch.js');
const { campaignsService } = await import('../src/services/campaigns.js');
const { markWrittenToLeadsContacted } = await import('../src/db/schema-outreach.js');
const { briefFacts } = await import('../src/services/weekly-brief.js');
const { boardFor } = await import('../src/services/pipeline-board.js');

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

const stage = (id) => db.prepare('SELECT status FROM leads WHERE id = ?').get(id).status;

beforeEach(() => {
  for (const t of ['outreach_queue', 'campaign_leads', 'activities', 'leads', 'campaigns', 'account_profiles', 'email_suppressions', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key = 'migration_written_to_contacted'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'u2', 'owner2@example.com', 'x', 'user', 'active', 'business')").run();
  db.prepare("INSERT INTO account_profiles (user_id, business_name, offer) VALUES (2, 'The Leadership Lab', 'Leadership programmes')").run();
  const lead = (id, status, email = `p${id}@x${id}.example`) =>
    db.prepare('INSERT INTO leads (id, user_id, name, email, company, status, source) VALUES (?, 2, ?, ?, ?, ?, ?)').run(id, `Person ${id}`, email, `Co ${id}`, status, 'ai_generated');
  lead(20, 'new');
  lead(21, 'qualified');
  lead(22, 'new', null);
  lead(23, 'new');
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (50, 2, 'TLL Q4', 'email', 'active', 'Hi', '<p>A real message</p>')").run();
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) return new Response(JSON.stringify({ id: 're_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return realFetch(url, init);
  };
});

test('a sequence email that goes out moves a New lead to Contacted, and leaves a further-along lead where it is', async () => {
  for (const id of [20, 21]) {
    db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, ?)").run(id);
    db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, subject, message, status, delay_days, scheduled_at, user_id) VALUES (50, ?, 1, 'email', 's', 'm', 'pending', 0, datetime('now', '-1 minute'), 2)").run(id);
  }
  assert.equal(await processOutreachQueue(), 2);
  assert.equal(stage(20), 'contacted');
  assert.equal(stage(21), 'qualified');
  assert.equal(stage(23), 'new', 'a lead nobody wrote to stays New');
});

test('the campaign email moves the leads it reached to Contacted; a LinkedIn-only lead it skipped stays New', async () => {
  for (const id of [20, 21, 22]) db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (50, ?)").run(id);
  const r = await campaignsService.sendCampaign(2, 50);
  assert.equal(r.sent, 2);
  assert.equal(stage(20), 'contacted');
  assert.equal(stage(21), 'qualified');
  assert.equal(stage(22), 'new');
});

test('leads already written to before this fix are moved to Contacted once', () => {
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status, sent_at) VALUES (50, 20, 'opened', datetime('now', '-3 days'))").run();
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (50, 23, 'bounced')").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, sent_at, user_id) VALUES (50, 22, 2, 'linkedin', 'note', 'sent', 1, datetime('now', '-2 days'), 2)").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, user_id) VALUES (50, 23, 1, 'email', 'm', 'draft', 0, 2)").run();
  // Emailed from a campaign that has since been deleted: only the timeline remembers.
  db.prepare("INSERT INTO leads (id, user_id, name, email, company, status, source) VALUES (24, 2, 'Person 24', 'p24@x24.example', 'Co 24', 'new', 'ai_generated')").run();
  db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (2, 24, 'email', 'Auto-outreach Step 1: Hello')").run();

  assert.equal(markWrittenToLeadsContacted(db), 3);
  assert.equal(stage(20), 'contacted', 'emailed by the campaign');
  assert.equal(stage(22), 'contacted', 'sent a LinkedIn note');
  assert.equal(stage(24), 'contacted', 'emailed, as the timeline shows');
  assert.equal(stage(23), 'new', 'a bounce and an unapproved draft reached nobody');
  assert.equal(stage(21), 'qualified');

  // Once: a lead someone later moves back to New is left there.
  db.prepare("UPDATE leads SET status = 'new' WHERE id = 20").run();
  assert.equal(markWrittenToLeadsContacted(db), 0);
  assert.equal(stage(20), 'new');
});

test('the review counts campaign emails as well as sequence steps, and the board shows who was written to', () => {
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status, sent_at) VALUES (50, 20, 'sent', datetime('now', '-2 days'))").run();
  db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description, created_at) VALUES (2, 20, 50, 'email', 'Sent campaign: TLL Q4', datetime('now', '-2 days'))").run();
  db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description, created_at) VALUES (2, 23, 50, 'email', 'Sent campaign: TLL Q4', datetime('now', '-9 days'))").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, delay_days, sent_at, user_id) VALUES (50, 21, 2, 'email', 'm', 'sent', 3, datetime('now', '-1 day'), 2)").run();
  markWrittenToLeadsContacted(db);

  const f = briefFacts(2);
  assert.equal(f.last_7_days.emails_sent, 2, 'one campaign email and one sequence step this week; the older one is not counted');
  assert.equal(f.board.new, 1);
  assert.equal(f.board.contacted, 2, 'lead 20 this week, lead 23 nine days ago');
  assert.equal(boardFor(2).columns.new.cards.find(c => c.lead_id === 22).hint, 'Not contacted yet');
});
