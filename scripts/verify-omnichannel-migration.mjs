// Prove migrateOmnichannel() on three databases:
//   1. fresh empty DB          (new install)
//   2. copy of the real DB     (existing install)
//   3. a DB seeded with the case-variant duplicate that would break the index
// and prove it is idempotent by running it twice on each.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const REPO = 'c:/laragon/www/Sales marketing agent';
const TMP = 'C:/Users/User/AppData/Local/Temp/claude/c--laragon-www-Sales-marketing-agent/b18ec682-71ed-4e98-af95-e2e14efaf2fb/scratchpad/mig';
fs.mkdirSync(TMP, { recursive: true });

const { initializeDatabase } = await import(`file:///${REPO}/src/db/schema.js`);

let failures = 0;
function check(label, cond, extra = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${label}${extra ? ' — ' + extra : ''}`);
}

function assertShape(db, label) {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='leads'").get().sql;
  check(`${label}: email no longer UNIQUE NOT NULL`, !/email\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i.test(ddl));

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['lead_sources', 'lead_inbox', 'lead_touchpoints', 'segments', 'segment_members', 'lead_scoring_rules', 'lead_settings']) {
    check(`${label}: table ${t} exists`, tables.includes(t));
  }

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  for (const i of ['idx_leads_user_email', 'idx_leads_user_linkedin', 'idx_inbox_idempotency']) {
    check(`${label}: critical index ${i} built`, idx.includes(i));
  }

  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  for (const c of ['source_id', 'first_source_id', 'last_source_id', 'email_normalized', 'phone_normalized', 'linkedin_normalized', 'touch_count']) {
    check(`${label}: leads.${c} added`, cols.includes(c));
  }

  check(`${label}: foreign_key_check clean`, db.prepare('PRAGMA foreign_key_check').all().length === 0);

  // The FK on the added column must actually resolve — this is the bug where
  // ALTER ... REFERENCES a not-yet-created table and blows up at first INSERT.
  db.prepare("INSERT OR IGNORE INTO users (id,username,email,password_hash,role) VALUES (900,'fk_probe','fk@probe.test','x','user')").run();
  db.prepare(`INSERT INTO lead_sources (id,user_id,type,name,ingest_key,auth_mode) VALUES (900,900,'webhook','probe','probe_key_900','hmac')`).run();
  let fkOk = true, fkErr = '';
  try {
    db.prepare("INSERT INTO leads (user_id,name,email,source,source_id) VALUES (900,'FK Probe','fk@probe.test','webhook',900)").run();
  } catch (e) { fkOk = false; fkErr = e.message; }
  check(`${label}: INSERT into leads with source_id FK works`, fkOk, fkErr);

  // Tenant isolation + null-email capability, the two things the rebuild bought.
  let sameEmailOk = true, sameErr = '';
  db.prepare("INSERT OR IGNORE INTO users (id,username,email,password_hash,role) VALUES (901,'t2','t2@probe.test','x','user')").run();
  try {
    db.prepare("INSERT INTO leads (user_id,name,email,email_normalized,source) VALUES (900,'A','dup@x.com','dup@x.com','manual')").run();
    db.prepare("INSERT INTO leads (user_id,name,email,email_normalized,source) VALUES (901,'B','dup@x.com','dup@x.com','manual')").run();
  } catch (e) { sameEmailOk = false; sameErr = e.message; }
  check(`${label}: same email across two tenants allowed`, sameEmailOk, sameErr);

  let dupBlocked = false;
  try {
    db.prepare("INSERT INTO leads (user_id,name,email,email_normalized,source) VALUES (900,'C','DUP@x.com','dup@x.com','manual')").run();
  } catch (e) { dupBlocked = /UNIQUE/i.test(e.message); }
  check(`${label}: duplicate email WITHIN a tenant blocked`, dupBlocked);

  let nullOk = true, nullErr = '';
  try {
    db.prepare("INSERT INTO leads (user_id,name,email,phone,phone_normalized,source) VALUES (900,'Phone Only 1',NULL,'+60123456789','60123456789','whatsapp')").run();
    db.prepare("INSERT INTO leads (user_id,name,email,phone,phone_normalized,source) VALUES (900,'Phone Only 2',NULL,'+60129999999','60129999999','whatsapp')").run();
  } catch (e) { nullOk = false; nullErr = e.message; }
  check(`${label}: multiple NULL-email leads under one tenant allowed`, nullOk, nullErr);

  // Idempotency index actually rejects a redelivered event.
  let idemBlocked = false;
  db.prepare("INSERT INTO lead_inbox (user_id,source_id,external_id,name) VALUES (900,900,'evt_1','x')").run();
  try { db.prepare("INSERT INTO lead_inbox (user_id,source_id,external_id,name) VALUES (900,900,'evt_1','x')").run(); }
  catch (e) { idemBlocked = /UNIQUE/i.test(e.message); }
  check(`${label}: redelivered webhook (same external_id) rejected`, idemBlocked);

  // ...but two events with NULL external_id must both be allowed.
  let nullExtOk = true;
  try {
    db.prepare("INSERT INTO lead_inbox (user_id,source_id,external_id,name) VALUES (900,900,NULL,'a')").run();
    db.prepare("INSERT INTO lead_inbox (user_id,source_id,external_id,name) VALUES (900,900,NULL,'b')").run();
  } catch (e) { nullExtOk = false; }
  check(`${label}: two events with NULL external_id both allowed`, nullExtOk);
}

// ── 1. Fresh DB ────────────────────────────────────────────────────────────
console.log('\n=== 1. FRESH DATABASE ===');
const freshPath = path.join(TMP, 'fresh.db');
fs.rmSync(freshPath, { force: true });
{
  const db = new Database(freshPath);
  db.pragma('foreign_keys = ON');
  initializeDatabase(db);
  initializeDatabase(db); // idempotency: second run must be a no-op
  console.log('  (initializeDatabase ran twice)');
  assertShape(db, 'fresh');
  db.close();
}

// ── 2. Copy of the real DB ─────────────────────────────────────────────────
console.log('\n=== 2. COPY OF REAL DATABASE ===');
const realCopy = path.join(TMP, 'real-copy.db');
fs.rmSync(realCopy, { force: true });
{
  const src = new Database(path.join(REPO, 'data/agent.db'));
  src.pragma('wal_checkpoint(TRUNCATE)');
  src.close();
  fs.copyFileSync(path.join(REPO, 'data/agent.db'), realCopy);

  const pre = new Database(realCopy, { readonly: true });
  const before = {
    leads: pre.prepare('SELECT COUNT(*) c FROM leads').get().c,
    cl: pre.prepare('SELECT COUNT(*) c FROM campaign_leads').get().c,
    act: pre.prepare('SELECT COUNT(*) c FROM activities').get().c,
    oq: pre.prepare('SELECT COUNT(*) c FROM outreach_queue').get().c,
    seq: pre.prepare("SELECT seq FROM sqlite_sequence WHERE name='leads'").get()?.seq,
  };
  pre.close();

  const db = new Database(realCopy);
  db.pragma('foreign_keys = ON');
  initializeDatabase(db);
  initializeDatabase(db);
  const after = {
    leads: db.prepare('SELECT COUNT(*) c FROM leads').get().c,
    cl: db.prepare('SELECT COUNT(*) c FROM campaign_leads').get().c,
    act: db.prepare('SELECT COUNT(*) c FROM activities').get().c,
    oq: db.prepare('SELECT COUNT(*) c FROM outreach_queue').get().c,
    seq: db.prepare("SELECT seq FROM sqlite_sequence WHERE name='leads'").get()?.seq,
  };
  console.log('  before', JSON.stringify(before));
  console.log('  after ', JSON.stringify(after));
  check('real: no lead rows lost', before.leads === after.leads);
  check('real: campaign_leads intact', before.cl === after.cl);
  check('real: activities intact', before.act === after.act);
  check('real: outreach_queue intact', before.oq === after.oq);
  check('real: AUTOINCREMENT seq preserved', before.seq === after.seq, `${before.seq} → ${after.seq}`);
  check('real: exactly one sqlite_sequence row for leads',
    db.prepare("SELECT COUNT(*) c FROM sqlite_sequence WHERE name='leads'").get().c === 1);

  // The point of preserving seq is the consequence, not the number: this DB has
  // MAX(id)=19 but seq=29, so leads 20-29 were deleted. A new lead must not
  // reuse one of those IDs and inherit a dead lead's campaign_leads rows.
  db.prepare("INSERT OR IGNORE INTO users (id,username,email,password_hash,role) VALUES (800,'seq','seq@probe.test','x','user')").run();
  const fresh = db.prepare(
    "INSERT INTO leads (user_id,name,email,email_normalized,source) VALUES (800,'Seq Probe','seq@probe.test','seq@probe.test','manual') RETURNING id"
  ).get();
  check('real: new lead gets a fresh ID, not a recycled one',
    fresh.id > before.seq, `new id ${fresh.id}, prior high-water ${before.seq}`);
  db.prepare('DELETE FROM leads WHERE id = ?').run(fresh.id);

  const backfilled = db.prepare("SELECT COUNT(*) c FROM leads WHERE email_normalized IS NOT NULL").get().c;
  check('real: normalized emails backfilled', backfilled === before.leads, `${backfilled}/${before.leads}`);
  assertShape(db, 'real');
  db.close();
}

// ── 3. Case-variant duplicate emails (the index-killer) ────────────────────
console.log('\n=== 3. CASE-VARIANT DUPLICATE EMAILS ===');
const dupPath = path.join(TMP, 'dupes.db');
fs.rmSync(dupPath, { force: true });
{
  // Build the OLD schema by hand, insert the collision, then migrate.
  const db = new Database(dupPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, role TEXT);
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      company TEXT, title TEXT, phone TEXT, source TEXT DEFAULT 'manual', score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','proposal','negotiation','won','lost')),
      notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, user_id INTEGER DEFAULT 1);
  `);
  db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'u','u@x.com','x','user')").run();
  // BINARY collation lets both of these coexist under the old global UNIQUE.
  db.prepare("INSERT INTO leads (id,user_id,name,email) VALUES (1,1,'Amos','Amos@Acme.com')").run();
  db.prepare("INSERT INTO leads (id,user_id,name,email) VALUES (2,1,'amos','amos@acme.com')").run();
  check('setup: two case-variant emails coexist pre-migration',
    db.prepare('SELECT COUNT(*) c FROM leads').get().c === 2);
  db.close();

  const db2 = new Database(dupPath);
  db2.pragma('foreign_keys = ON');
  const { migrateOmnichannel } = await import(`file:///${REPO}/src/db/schema-omnichannel.js`);
  let threw = null;
  try { migrateOmnichannel(db2); migrateOmnichannel(db2); } catch (e) { threw = e.message; }
  check('dupes: migration did not throw', threw === null, threw || '');
  const idx = db2.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
  check('dupes: idx_leads_user_email still built', idx.includes('idx_leads_user_email'));
  const rows = db2.prepare('SELECT id, email, email_normalized, notes FROM leads ORDER BY id').all();
  check('dupes: both rows survive', rows.length === 2);
  check('dupes: earliest row keeps its key', rows[0].email_normalized === 'amos@acme.com');
  check('dupes: later row key cleared', rows[1].email_normalized === null);
  check('dupes: later row raw email preserved', rows[1].email === 'amos@acme.com');
  check('dupes: later row annotated for manual merge', /Case-variant duplicate of lead #1/.test(rows[1].notes || ''));
  db2.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
