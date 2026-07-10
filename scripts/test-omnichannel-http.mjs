import crypto from 'crypto';
import fs from 'fs';

const REPO = 'c:/laragon/www/Sales marketing agent';
const DB = 'C:/Users/User/AppData/Local/Temp/claude/c--laragon-www-Sales-marketing-agent/b18ec682-71ed-4e98-af95-e2e14efaf2fb/scratchpad/boot2.db';

// Checkpoint the live WAL into the main file first, or the copy is a stale
// pre-migration snapshot (the newest schema changes live in the -wal file).
const Database0 = (await import('better-sqlite3')).default;
const srcDb = new Database0(REPO + '/data/agent.db');
srcDb.pragma('wal_checkpoint(TRUNCATE)');
srcDb.close();

fs.copyFileSync(REPO + '/data/agent.db', DB);
for (const s of ['-wal', '-shm']) { try { fs.rmSync(DB + s); } catch {} }

process.env.SA_DB_PATH = DB;
process.env.ENCRYPTION_KEY = 'test';
process.env.PORT = '3998';

await import(`file:///${REPO}/src/server.js`);
await new Promise(r => setTimeout(r, 900));
const base = 'http://localhost:3998';

// Reuse the server's already-migrated singleton rather than opening a second
// handle (which could race the boot migration that adds sessions.last_activity).
const db = (await import(`file:///${REPO}/src/db/index.js`)).default;
db.prepare("INSERT OR IGNORE INTO users (id,username,email,password_hash,role,plan,email_verified) VALUES (1,'a','a@a.test','x','superadmin','business',1)").run();
const tok = 'tok_' + crypto.randomBytes(8).toString('hex');
// Don't name last_activity: SQLite refuses to add a CURRENT_TIMESTAMP-default
// column to a populated table, so old production DBs lack it. requireAuth reads
// it defensively, so a session row without it authenticates fine.
const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
if (sessionCols.includes('last_activity')) {
  db.prepare("INSERT INTO sessions (token,user_id,expires_at,last_activity) VALUES (?,?,datetime('now','+1 day'),datetime('now'))").run(tok, 1);
} else {
  db.prepare("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(tok, 1);
}
const H = { authorization: 'Bearer ' + tok, 'content-type': 'application/json' };

let pass = 0, fail = 0;
const ck = (l, c, x = '') => { if (c) { pass++; console.log('  [PASS] ' + l); } else { fail++; console.log('  [FAIL] ' + l + (x ? ' — ' + x : '')); } };

const created = await (await fetch(base + '/api/sources', { method: 'POST', headers: H, body: JSON.stringify({ type: 'webhook', name: 'E2E hook', auto_promote: true }) })).json();
ck('POST /sources creates a source with ingest_url', created.type === 'webhook' && !!created.ingest_url);
ck('secret returned once at creation', typeof created.secret === 'string' && created.secret.length >= 32);
const secret = created.secret, key = created.ingest_key;

await fetch(base + '/api/sources/settings/lead', { method: 'PUT', headers: H, body: JSON.stringify({ auto_promote_threshold: 0, ai_qualify_threshold: 101 }) });

const body = Buffer.from(JSON.stringify({ name: 'Live Test', email: 'live@corp.io', phone: '+60123334444', title: 'CEO' }), 'utf8');
const t = Math.floor(Date.now() / 1000).toString();
const mac = crypto.createHmac('sha256', secret); mac.update(t + '.'); mac.update(body);
const sig = 't=' + t + ',v1=' + mac.digest('hex');

const good = await fetch(base + '/api/ingest/' + key, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eiaaw-signature': sig }, body });
const goodJson = await good.json();
ck('signed ingest returns 202 accepted', good.status === 202 && goodJson.status === 'accepted', good.status + ' ' + JSON.stringify(goodJson));

const evil = await fetch(base + '/api/ingest/' + key, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eiaaw-signature': sig }, body: Buffer.from(JSON.stringify({ name: 'evil', email: 'evil@x.io' })) });
ck('tampered body rejected with 401', evil.status === 401);

const noSig = await fetch(base + '/api/ingest/' + key, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
ck('unsigned request rejected with 401', noSig.status === 401);

// Redelivery (same external id would need an id in payload; webhook uses body id).
// Re-POST the exact same signed request → idempotent by (source, external_id) only
// if the payload carried an id; here it doesn't, so it dedupes by identity instead.
await new Promise(r => setTimeout(r, 200));
const lead = db.prepare("SELECT id,name,email,source,status,title FROM leads WHERE email_normalized='live@corp.io'").get();
ck('lead landed in leads table', !!lead && lead.name === 'Live Test' && lead.title === 'CEO', JSON.stringify(lead));
ck('lead attributed to the webhook source string', lead && lead.source === 'webhook');
ck('evil lead did NOT land', !db.prepare("SELECT id FROM leads WHERE email_normalized='evil@x.io'").get());

const funnel = await (await fetch(base + '/api/sources/funnel', { headers: H })).json();
const hook = funnel.find(f => f.name === 'E2E hook');
ck('funnel shows received + leads counts', hook && hook.received_count >= 1 && hook.leads_count >= 1, JSON.stringify(hook));
ck('funnel shows the rejected (tampered/unsigned) attempts', hook && hook.rejected_count >= 2, 'rejected=' + (hook && hook.rejected_count));

// Segment over the just-created lead.
const segRes = await (await fetch(base + '/api/segments', { method: 'POST', headers: H, body: JSON.stringify({ name: 'CEOs', kind: 'dynamic', filter: { match: 'all', groups: [{ match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'CEO' }] }] } }) })).json();
const members = await (await fetch(base + '/api/segments/' + segRes.id + '/members', { headers: H })).json();
ck('dynamic segment finds the CEO lead', Array.isArray(members) && members.some(m => m.email === 'live@corp.io'), JSON.stringify(members.map(m => m.email)));

// ── Slice 4 retrofit: a public FORM submission must now become a lead ──────
// Build a form owned by tenant 1, then POST to its public submit endpoint with
// NO auth. Before the retrofit this recorded a submission but never a lead.
const form = db.prepare(`
  INSERT INTO forms (user_id, name, title, fields)
  VALUES (1, 'Contact', 'Talk to us', ?) RETURNING id
`).get(JSON.stringify([
  { id: 'f1', type: 'name', name: 'name', label: 'Name', required: true },
  { id: 'f2', type: 'email', name: 'email', label: 'Email', required: true },
  { id: 'f3', type: 'phone', name: 'phone', label: 'Phone', required: false },
  { id: 'f4', type: 'textarea', name: 'help', label: 'How can we help?', required: false },
]));
const submit = await fetch(base + '/api/forms/public/' + form.id + '/submit', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ data: { name: 'Form Person', email: 'formlead@corp.io', phone: '+60127778888', help: 'Need a demo' } }),
});
ck('public form submit returns success', submit.status === 200);
await new Promise(r => setTimeout(r, 150));
const formLead = db.prepare("SELECT id,name,email,phone,source,user_id,notes FROM leads WHERE email_normalized='formlead@corp.io'").get();
ck('form submission became a lead', !!formLead && formLead.name === 'Form Person', JSON.stringify(formLead));
ck('form lead owned by the form owner (tenant 1), not HQ default', formLead && formLead.user_id === 1);
ck('form lead captured the phone', formLead && formLead.phone === '+60127778888');
ck('form lead message folded into notes', formLead && /Need a demo/.test(formLead.notes || ''));
const formSub = db.prepare('SELECT COUNT(*) c FROM form_submissions WHERE form_id = ?').get(form.id).c;
ck('raw submission still recorded alongside the lead', formSub === 1);

db.close();
console.log(`\n${fail === 0 ? `E2E HTTP: ALL ${pass} PASSED` : `${fail} FAILED / ${pass} passed`}`);
process.exit(fail === 0 ? 0 : 1);
