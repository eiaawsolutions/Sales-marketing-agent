import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateOutreach } from '../src/db/schema-outreach.js';

// The rebuilds that widen the outreach_queue and email_suppressions CHECKs
// must keep every row, every id and the AUTOINCREMENT high-water mark, and be
// a no-op on the next boot.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-schema-outreach-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('rebuild keeps rows and ids, holds the id counter, and runs once', () => {
  const db = new Database(path.join(dir, 'old.db'));
  try { runRebuildChecks(db); } finally { db.close(); }
});

function runRebuildChecks(db) {
  db.exec(`
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
    CREATE TABLE outreach_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
      step INTEGER DEFAULT 1, channel TEXT NOT NULL, subject TEXT, message TEXT NOT NULL, goal TEXT,
      delay_days INTEGER DEFAULT 0, scheduled_at DATETIME, sent_at DATETIME,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','skipped','failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, user_id INTEGER DEFAULT 1, provider_message_id TEXT);
    CREATE TABLE email_suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, email_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('unsubscribe','complaint','manual')),
      campaign_id INTEGER, lead_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, email_hash));
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT);
  `);
  db.prepare("INSERT INTO campaigns (id, name) VALUES (1, 'c')").run();
  for (let i = 1; i <= 9; i++) db.prepare('INSERT INTO leads (id, name) VALUES (?, ?)').run(i, `l${i}`);
  for (let i = 1; i <= 5; i++) {
    db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, channel, message, status, provider_message_id) VALUES (1, ?, 'email', 'm', 'sent', ?)").run(i, `re_${i}`);
  }
  db.prepare('DELETE FROM outreach_queue WHERE id = 5').run(); // high-water mark 5, max id 4
  db.prepare("INSERT INTO email_suppressions (user_id, email_hash, reason) VALUES (1, 'h', 'unsubscribe')").run();

  migrateOutreach(db);

  assert.deepEqual(db.prepare('SELECT id, provider_message_id FROM outreach_queue ORDER BY id').all().map(r => r.id), [1, 2, 3, 4]);
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, channel, message, status) VALUES (1, 9, 'email', 'm', 'draft')").run();
  assert.equal(db.prepare("SELECT id FROM outreach_queue WHERE status = 'draft'").get().id, 6, 'deleted id 5 is never reused');
  db.prepare("UPDATE outreach_queue SET status = 'sending' WHERE id = 6").run();
  assert.throws(() => db.prepare("UPDATE outreach_queue SET status = 'bogus' WHERE id = 6").run(), /CHECK/);

  db.prepare("INSERT INTO email_suppressions (user_id, email_hash, reason) VALUES (1, 'h2', 'bounce')").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM email_suppressions').get().c, 2);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_outreach_queue_provider_message_id'").get());

  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'outreach_queue'").get().sql;
  migrateOutreach(db);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'outreach_queue'").get().sql, before);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_sequence WHERE name = 'outreach_queue'").get().c, 1);
}
