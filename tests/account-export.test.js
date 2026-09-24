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
