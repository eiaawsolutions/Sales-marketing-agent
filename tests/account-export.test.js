import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-export-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { exportAccountData } = await import('../src/services/account-export.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addUser(id, email) {
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan)
              VALUES (?, ?, ?, 'hash-must-not-leak', 'user', 'active', 'pro')`).run(id, `user${id}`, email);
}
function addLead(userId, email) {
  db.prepare("INSERT INTO leads (user_id, name, email, source, notes) VALUES (?, 'Lead', ?, 'manual', 'n')").run(userId, email);
}

test('account export holds only that account, without secrets', () => {
  addUser(8, 'owner@customer.test');
  addUser(9, 'other@customer.test');
  addLead(8, 'mine@lead.test');
  addLead(9, 'theirs@lead.test');
  db.prepare(`INSERT INTO lead_sources (user_id, type, name, ingest_key, secret_enc, auth_mode)
              VALUES (8, 'webhook', 'Hook', 'ik_secret_key', 'enc:abc', 'hmac')`).run();

  const out = exportAccountData(db, 8);
  assert.equal(out.account.email, 'owner@customer.test');
  assert.equal(out.account.password_hash, undefined);
  assert.ok(!JSON.stringify(out).includes('hash-must-not-leak'));
  assert.deepEqual(out.data.leads.map((l) => l.email), ['mine@lead.test']);
  assert.equal(out.summary.leads, 1);
  assert.equal(out.data.lead_sources.length, 1);
  assert.equal(out.data.lead_sources[0].ingest_key, undefined);
  assert.equal(out.data.lead_sources[0].secret_enc, undefined);
  assert.equal(exportAccountData(db, 999), null);
});

test('account export includes that account\'s do-not-email list', () => {
  db.prepare("INSERT INTO email_suppressions (user_id, email_hash, reason, campaign_id, lead_id) VALUES (8, 'hash-of-mine', 'unsubscribe', 3, 4)").run();
  db.prepare("INSERT INTO email_suppressions (user_id, email_hash, reason) VALUES (8, 'hash-of-complaint', 'complaint')").run();
  db.prepare("INSERT INTO email_suppressions (user_id, email_hash, reason) VALUES (9, 'hash-of-theirs', 'unsubscribe')").run();

  const out = exportAccountData(db, 8);
  assert.deepEqual(out.data.email_suppressions.map((r) => [r.email_hash, r.reason]), [['hash-of-mine', 'unsubscribe'], ['hash-of-complaint', 'complaint']]);
  assert.equal(out.data.email_suppressions[0].user_id, undefined, 'internal ids stay out');
  assert.equal(out.summary.email_suppressions, 2);
  assert.match(out.notes.email_suppressions, /SHA-256/);
});
