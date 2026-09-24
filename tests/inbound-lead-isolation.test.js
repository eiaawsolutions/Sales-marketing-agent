import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A website visitor's enquiry must never be appended to a CUSTOMER's lead
// that happens to share the email address: it belongs to EIAAW's own account.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-inbound-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { saveInboundLead } = await import('../src/routes/forms.js');

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('inbound enquiry does not touch another account\'s lead with the same email', () => {
  // User 1 is EIAAW's own (founder) account, which owns website enquiries.
  db.prepare(`INSERT OR IGNORE INTO users (id, username, email, password_hash, role, status, plan)
              VALUES (1, 'founder', 'founder@example.com', 'x', 'admin', 'active', 'pro')`).run();
  const customer = db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan)
                               VALUES (2, 'cust', 'cust@example.com', 'x', 'user', 'active', 'pro')`).run().lastInsertRowid;
  const theirs = db.prepare(`INSERT INTO leads (user_id, name, email, status, notes) VALUES (?, 'Pat', 'pat@example.com', 'new', 'customer private notes')`)
    .run(customer).lastInsertRowid;

  const res = saveInboundLead({ name: 'Pat', email: 'pat@example.com', phone: '0123456789', site: 'parent', channel: 'chatbot', note: 'Consent: agreed' });

  assert.notEqual(res.id, theirs, 'must not reuse the customer\'s lead');
  assert.equal(db.prepare('SELECT notes FROM leads WHERE id = ?').get(theirs).notes, 'customer private notes');
  const ours = db.prepare('SELECT user_id FROM leads WHERE id = ?').get(res.id);
  assert.notEqual(ours.user_id, customer);
});
