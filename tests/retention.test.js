import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-retention-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { runRetention, findStaleEnquiries } = await import('../src/services/retention.js');
const { FOUNDER_HQ_EMAIL } = await import('../src/config/hq.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-09-25T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
// SQLite CURRENT_TIMESTAMP format, UTC.
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 19).replace('T', ' ');
const quiet = { log() {} };
const INBOUND_NOTES = 'Lead type: Inbound (self-reported via website chatbot)\nConfidence: Self-reported — verify before outreach';

function reset() {
  for (const t of ['form_submissions', 'forms', 'outreach_queue', 'campaign_leads', 'appointments', 'activities',
    'pipeline', 'generated_content', 'ai_cost_log', 'lead_touchpoints', 'segment_members', 'segments',
    'lead_inbox', 'leads', 'campaigns', 'lead_sources', 'lead_scoring_rules', 'lead_settings', 'agent_tasks',
    'sessions', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key LIKE 'subscription_ended_%' OR key LIKE 'stripe_%' OR key LIKE 'terms_acceptance_%'").run();
}

function addUser(id, email, status = 'active', role = 'user') {
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan)
              VALUES (?, ?, ?, 'x', ?, ?, 'pro')`).run(id, `user${id}`, email, role, status);
}

function addLead({ userId = 1, email, source = 'chatbot_sales_agent', notes = INBOUND_NOTES, createdDaysAgo, status = 'new' }) {
  return db.prepare(`INSERT INTO leads (user_id, name, email, source, notes, status, created_at, updated_at)
                     VALUES (?, 'Visitor', ?, ?, ?, ?, ?, ?)`)
    .run(userId, email, source, notes, status, ago(createdDaysAgo), ago(createdDaysAgo)).lastInsertRowid;
}

function addActivity(leadId, daysAgo, userId = 1) {
  db.prepare(`INSERT INTO activities (lead_id, type, description, user_id, created_at) VALUES (?, 'note', 'x', ?, ?)`)
    .run(leadId, userId, ago(daysAgo));
}

const count = (sql, ...p) => db.prepare(sql).get(...p).c;

beforeEach(() => {
  reset();
  addUser(1, FOUNDER_HQ_EMAIL, 'active', 'superadmin');
});

test('deletes an enquiry 24 months after last contact, with its activity rows', () => {
  const old = addLead({ email: 'old@visitor.test', createdDaysAgo: 800 });
  addActivity(old, 790);
  const summary = runRetention({ db, now: NOW, log: quiet });
  assert.equal(summary.enquiriesDeleted, 1);
  assert.equal(count('SELECT COUNT(*) c FROM leads WHERE id = ?', old), 0);
  assert.equal(count('SELECT COUNT(*) c FROM activities WHERE lead_id = ?', old), 0);
});

test('keeps enquiries with recent contact, customers, won deals and non-inbound leads', () => {
  const recentContact = addLead({ email: 'recent@visitor.test', createdDaysAgo: 800 });
  addActivity(recentContact, 30);
  const young = addLead({ email: 'young@visitor.test', createdDaysAgo: 100 });
  addUser(7, 'became.customer@visitor.test');
  const customer = addLead({ email: 'Became.Customer@visitor.test', createdDaysAgo: 800 });
  const won = addLead({ email: 'won@visitor.test', createdDaysAgo: 800, status: 'won' });
  // A customer's own lead with a look-alike source label but no inbound signature.
  const tenantLead = addLead({ userId: 7, email: 'tenant@lead.test', source: 'chatbot_import', notes: 'imported', createdDaysAgo: 800 });

  assert.deepEqual(findStaleEnquiries(db, NOW), []);
  runRetention({ db, now: NOW, log: quiet });
  for (const id of [recentContact, young, customer, won, tenantLead]) {
    assert.equal(count('SELECT COUNT(*) c FROM leads WHERE id = ?', id), 1, `lead ${id} should be kept`);
  }
});

test('an upcoming appointment counts as contact', () => {
  const lead = addLead({ email: 'booked@visitor.test', createdDaysAgo: 800 });
  db.prepare(`INSERT INTO appointments (lead_id, user_id, title, scheduled_at, created_at, updated_at)
              VALUES (?, 1, 'Demo', ?, ?, ?)`).run(lead, ago(-5), ago(800), ago(800));
  assert.deepEqual(findStaleEnquiries(db, NOW), []);
});

test('deletes an account and everything it owns 90 days after the subscription ends', () => {
  addUser(2, 'ended@customer.test', 'suspended');
  const lead = addLead({ userId: 2, email: 'prospect@x.test', source: 'apollo', notes: 'n', createdDaysAgo: 10 });
  addActivity(lead, 5, 2);
  const camp = db.prepare("INSERT INTO campaigns (name, type, user_id) VALUES ('C', 'email', 2)").run().lastInsertRowid;
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)").run(camp, lead);
  db.prepare("INSERT INTO pipeline (lead_id, stage, user_id) VALUES (?, 'prospecting', 2)").run(lead);
  db.prepare("INSERT INTO settings (key, value) VALUES ('stripe_customer_2', 'cus_x')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('subscription_ended_2', ?)").run(new Date(NOW.getTime() - 91 * DAY).toISOString());

  const summary = runRetention({ db, now: NOW, log: quiet });
  assert.equal(summary.accountsDeleted, 1);
  assert.equal(count('SELECT COUNT(*) c FROM users WHERE id = 2'), 0);
  assert.equal(count('SELECT COUNT(*) c FROM leads WHERE user_id = 2'), 0);
  assert.equal(count('SELECT COUNT(*) c FROM campaigns WHERE user_id = 2'), 0);
  assert.equal(count('SELECT COUNT(*) c FROM activities WHERE lead_id = ?', lead), 0);
  assert.equal(count("SELECT COUNT(*) c FROM settings WHERE key IN ('stripe_customer_2', 'subscription_ended_2')"), 0);
  assert.equal(count('SELECT COUNT(*) c FROM users WHERE id = 1'), 1);
});

test('keeps accounts inside the 90 days, reinstated accounts and the HQ account', () => {
  addUser(3, 'recent@customer.test', 'suspended');
  db.prepare("INSERT INTO settings (key, value) VALUES ('subscription_ended_3', ?)").run(new Date(NOW.getTime() - 30 * DAY).toISOString());
  addUser(4, 'back@customer.test', 'active');
  db.prepare("INSERT INTO settings (key, value) VALUES ('subscription_ended_4', ?)").run(new Date(NOW.getTime() - 200 * DAY).toISOString());
  db.prepare("INSERT INTO settings (key, value) VALUES ('subscription_ended_1', ?)").run(new Date(NOW.getTime() - 200 * DAY).toISOString());
  addUser(5, 'legacy@customer.test', 'suspended'); // ended before markers existed

  const summary = runRetention({ db, now: NOW, log: quiet });
  assert.equal(summary.accountsDeleted, 0);
  assert.equal(count('SELECT COUNT(*) c FROM users WHERE id IN (1, 3, 4, 5)'), 4);
  assert.equal(summary.suspendedWithoutMarker, 1);
  // Reinstated account and HQ: the clock is cleared. The 30-day one keeps running.
  assert.equal(count("SELECT COUNT(*) c FROM settings WHERE key IN ('subscription_ended_1', 'subscription_ended_4')"), 0);
  assert.equal(count("SELECT COUNT(*) c FROM settings WHERE key = 'subscription_ended_3'"), 1);
});

test('dry run counts but deletes nothing, and a second live run is a no-op', () => {
  addLead({ email: 'old2@visitor.test', createdDaysAgo: 900 });
  addUser(6, 'gone@customer.test', 'suspended');
  db.prepare("INSERT INTO settings (key, value) VALUES ('subscription_ended_6', ?)").run(new Date(NOW.getTime() - 120 * DAY).toISOString());

  const dry = runRetention({ db, now: NOW, dryRun: true, log: quiet });
  assert.equal(dry.staleEnquiries, 1);
  assert.equal(dry.expiredAccounts, 1);
  assert.equal(dry.enquiriesDeleted, 0);
  assert.equal(count('SELECT COUNT(*) c FROM leads'), 1);
  assert.equal(count('SELECT COUNT(*) c FROM users WHERE id = 6'), 1);

  const live = runRetention({ db, now: NOW, log: quiet });
  assert.equal(live.enquiriesDeleted, 1);
  assert.equal(live.accountsDeleted, 1);

  const again = runRetention({ db, now: NOW, log: quiet });
  assert.equal(again.enquiriesDeleted, 0);
  assert.equal(again.accountsDeleted, 0);
});

test('logs counts only, never personal data', () => {
  addLead({ email: 'secret.person@visitor.test', createdDaysAgo: 900 });
  const lines = [];
  runRetention({ db, now: NOW, log: { log: (m) => lines.push(m) } });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('secret.person'));
});
