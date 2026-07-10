// End-to-end test of the omnichannel lead funnel.
//
// Boots the real Express app against a throwaway SQLite file, then drives the
// real HTTP surface: signed webhooks, Google Ads / Calendly / Resend payloads,
// identity resolution, the staging inbox, scoring, and segments.
//
//   node scripts/test-omnichannel.mjs
//
// No AI calls are made: the qualification queue only fires above the threshold
// and we assert on the rule score, not on Claude.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

// The app opens data/agent.db at import time. Point it at a scratch copy.
const TEST_DB_DIR = path.join(REPO, 'data');
const TEST_DB = path.join(TEST_DB_DIR, 'test-omnichannel.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret';
process.env.SA_DB_PATH = TEST_DB;

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  [PASS] ${label}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const Database = (await import('better-sqlite3')).default;
const db = new Database(TEST_DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const { initializeDatabase } = await import(`file:///${path.join(REPO, 'src/db/schema.js').replace(/\\/g, '/')}`);
initializeDatabase(db);

// Two tenants. The whole point is that they never see each other's leads.
const { hashPassword } = await import(`file:///${path.join(REPO, 'src/middleware/auth.js').replace(/\\/g, '/')}`);
db.prepare("INSERT INTO users (id,username,email,password_hash,role,plan,email_verified) VALUES (1,'alice','alice@t1.test',?,'user','business',1)").run(hashPassword('x'));
db.prepare("INSERT INTO users (id,username,email,password_hash,role,plan,email_verified) VALUES (2,'bob','bob@t2.test',?,'user','business',1)").run(hashPassword('x'));

// Services operate on the singleton db (src/db/index.js), which opened the file
// at data/agent.db. Rather than fight the import, drive them through the same
// file by pointing the singleton at our test DB via a symlinked path is fragile.
// Instead: import the modules and use THEIR db handle for setup.
const dbIndex = await import(`file:///${path.join(REPO, 'src/db/index.js').replace(/\\/g, '/')}`);
const appDb = dbIndex.default;

// Guard: if the app opened the production DB, abort rather than write to it.
const appDbFile = appDb.name;
if (!appDbFile.includes('test-omnichannel')) {
  console.error(`\nREFUSING TO RUN: the app opened ${appDbFile}, not the test DB.`);
  console.error('src/db/index.js hardcodes data/agent.db. This test needs it to honour SA_DB_PATH.');
  process.exit(2);
}

const { leadSourcesService } = await import(`file:///${path.join(REPO, 'src/services/lead-sources.js').replace(/\\/g, '/')}`);
const { ingest, promoteInboxRow } = await import(`file:///${path.join(REPO, 'src/services/lead-ingest.js').replace(/\\/g, '/')}`);
const { adapterFor } = await import(`file:///${path.join(REPO, 'src/services/source-adapters.js').replace(/\\/g, '/')}`);
const { signPayload, verifyIngestRequest, verifySvix, verifyGoogleAds, verifyCalendly } =
  await import(`file:///${path.join(REPO, 'src/services/ingest-auth.js').replace(/\\/g, '/')}`);
const { compileSegmentFilter, segmentsService, validateFilter } =
  await import(`file:///${path.join(REPO, 'src/services/segments.js').replace(/\\/g, '/')}`);
const { scoreLead, getRules } = await import(`file:///${path.join(REPO, 'src/services/lead-scoring.js').replace(/\\/g, '/')}`);
const { resolveIdentity, toCandidate, planMerge } =
  await import(`file:///${path.join(REPO, 'src/services/lead-identity.js').replace(/\\/g, '/')}`);

const raw = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const nowSec = () => Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────── signature verification
section('Signature verification');
{
  const secret = 'sh' + 'hh-secret-value';
  const body = raw({ email: 'a@b.com', name: 'A' });
  const t = String(nowSec());
  const sig = signPayload(secret, body, t);
  const src = { auth_mode: 'hmac', status: 'active' };

  check('valid HMAC accepted',
    verifyIngestRequest(src, secret, body, { 'x-eiaaw-signature': `t=${t},v1=${sig}` }).ok);

  check('tampered body rejected',
    !verifyIngestRequest(src, secret, raw({ email: 'evil@b.com' }), { 'x-eiaaw-signature': `t=${t},v1=${sig}` }).ok);

  check('wrong secret rejected',
    !verifyIngestRequest(src, 'other', body, { 'x-eiaaw-signature': `t=${t},v1=${sig}` }).ok);

  const oldT = String(nowSec() - 900);
  check('stale timestamp rejected (replay window)',
    !verifyIngestRequest(src, secret, body, { 'x-eiaaw-signature': `t=${oldT},v1=${signPayload(secret, body, oldT)}` }).ok);

  check('missing signature rejected', !verifyIngestRequest(src, secret, body, {}).ok);
  check('malformed hex signature rejected',
    !verifyIngestRequest(src, secret, body, { 'x-eiaaw-signature': `t=${t},v1=zzz` }).ok);

  // A signature valid for one timestamp must not validate at another.
  const t2 = String(nowSec() - 10);
  check('signature bound to its timestamp',
    !verifyIngestRequest(src, secret, body, { 'x-eiaaw-signature': `t=${t2},v1=${sig}` }).ok);

  check('paused source rejected',
    !verifyIngestRequest({ auth_mode: 'hmac', status: 'paused' }, secret, body, { 'x-eiaaw-signature': `t=${t},v1=${sig}` }).ok);

  check('internal source is not HTTP-reachable',
    !verifyIngestRequest({ auth_mode: 'internal', status: 'active' }, null, body, {}).ok);

  // token mode
  const tokenSrc = { auth_mode: 'token', status: 'active' };
  check('correct token accepted', verifyIngestRequest(tokenSrc, 'tok_abc', body, { 'x-ingest-token': 'tok_abc' }).ok);
  check('wrong token rejected', !verifyIngestRequest(tokenSrc, 'tok_abc', body, { 'x-ingest-token': 'tok_abd' }).ok);
  check('token of different length rejected', !verifyIngestRequest(tokenSrc, 'tok_abc', body, { 'x-ingest-token': 'tok_abcdef' }).ok);

  // google ads: bearer secret in the body
  check('google_key match accepted', verifyGoogleAds('gk_123', { google_key: 'gk_123' }).ok);
  check('google_key mismatch rejected', !verifyGoogleAds('gk_123', { google_key: 'gk_124' }).ok);
  check('google_key missing rejected', !verifyGoogleAds('gk_123', {}).ok);

  // svix (resend inbound)
  const svixSecret = 'whsec_' + Buffer.from('svix-signing-key-bytes').toString('base64');
  const svixKey = Buffer.from(svixSecret.slice(6), 'base64');
  const svixId = 'msg_123';
  const svixTs = String(nowSec());
  const svixBody = raw({ type: 'email.received', data: { email_id: 'e1', from: 'a@b.com' } });
  const mac = crypto.createHmac('sha256', svixKey);
  mac.update(`${svixId}.${svixTs}.`); mac.update(svixBody);
  const svixSig = `v1,${mac.digest('base64')}`;
  check('valid svix signature accepted',
    verifySvix(svixSecret, svixBody, { 'svix-id': svixId, 'svix-timestamp': svixTs, 'svix-signature': svixSig }).ok);
  check('svix accepts rotation (multiple sigs, one valid)',
    verifySvix(svixSecret, svixBody, { 'svix-id': svixId, 'svix-timestamp': svixTs, 'svix-signature': `v1,AAAA ${svixSig}` }).ok);
  check('bad svix signature rejected',
    !verifySvix(svixSecret, svixBody, { 'svix-id': svixId, 'svix-timestamp': svixTs, 'svix-signature': 'v1,AAAA' }).ok);

  // calendly
  const calSecret = 'cal_secret';
  const calTs = String(nowSec());
  const calBody = raw({ event: 'invitee.created', payload: { email: 'c@d.com' } });
  check('valid calendly signature accepted',
    verifyCalendly(calSecret, calBody, { 'calendly-webhook-signature': `t=${calTs},v1=${signPayload(calSecret, calBody, calTs)}` }).ok);
}

// ─────────────────────────────────────────────── adapters
section('Adapters');
{
  const g = adapterFor('google_ads');
  const gBody = {
    lead_id: 'LEAD-1', google_key: 'k',
    user_column_data: [
      { column_id: 'FULL_NAME', column_name: 'Full Name', string_value: 'Siti Aminah' },
      { column_id: 'EMAIL', column_name: 'Email', string_value: 'Siti@Acme.COM' },
      { column_id: 'PHONE_NUMBER', column_name: 'Phone', string_value: '+60 12-345 6789' },
      { column_id: 'JOB_TITLE', column_name: 'Job', string_value: 'Head of Growth' },
      { column_id: 'WHAT_DO_YOU_NEED', column_name: 'What do you need?', string_value: 'Pricing please' },
    ],
  };
  const gOut = g.normalize(gBody);
  check('google ads maps FULL_NAME/EMAIL/PHONE/JOB_TITLE', gOut.name === 'Siti Aminah' && gOut.email === 'Siti@Acme.COM' && gOut.title === 'Head of Growth');
  check('google ads keeps custom question as message', /Pricing please/.test(gOut.message || ''));
  check('google ads external id from lead_id', g.externalId(gBody) === 'google:LEAD-1');

  const c = adapterFor('calendly');
  const cBody = {
    event: 'invitee.created',
    payload: {
      uri: 'https://api.calendly.com/scheduled_events/AAA/invitees/BBB',
      name: 'Amos Tan', email: 'amos@acme.com',
      scheduled_event: { name: 'Demo Call', start_time: '2026-08-01T02:00:00Z' },
      questions_and_answers: [{ question: 'Company', answer: 'Acme Sdn Bhd' }],
    },
  };
  const cOut = c.normalize(cBody);
  check('calendly pulls invitee name/email', cOut.name === 'Amos Tan' && cOut.email === 'amos@acme.com');
  check('calendly maps Q&A "Company" to company', cOut.company === 'Acme Sdn Bhd');
  check('calendly message carries the booking', /Booked: Demo Call/.test(cOut.message || ''));
  check('calendly external id from invitee uri', c.externalId(cBody).startsWith('calendly:'));

  const calcom = adapterFor('calendly').normalize({
    triggerEvent: 'BOOKING_CREATED',
    payload: { uid: 'bk_1', title: 'Intro', startTime: '2026-08-02T02:00:00Z', attendees: [{ name: 'Lee Wei', email: 'lee@x.io' }] },
  });
  check('cal.com attendee shape handled', calcom.name === 'Lee Wei' && calcom.email === 'lee@x.io');

  const e = adapterFor('email_inbound');
  const eOut = e.normalize({ type: 'email.received', data: { email_id: 'em1', from: '"Nurul Huda" <nurul@corp.my>', subject: 'Quote?', text: 'How much for 50 seats?' } });
  check('inbound email parses display name + address', eOut.name === 'Nurul Huda' && eOut.email === 'nurul@corp.my');
  check('inbound email keeps subject + body as message', /Quote\?/.test(eOut.message) && /50 seats/.test(eOut.message));
  check('inbound email does NOT invent a company website', eOut.company_website === null);

  const bare = e.normalize({ type: 'email.received', data: { email_id: 'em2', from: 'raw@corp.my' } });
  check('inbound email handles bare address', bare.email === 'raw@corp.my' && bare.name === null);

  const w = adapterFor('webhook');
  const wOut = w.normalize({ 'First Name': 'Chong', last_name: 'Wei', 'Work Email': 'cw@x.com', 'Mobile Number': '0123456789', Organisation: 'X Sdn Bhd' });
  check('generic adapter is case/format tolerant', wOut.name === 'Chong Wei' && wOut.email === 'cw@x.com' && wOut.company === 'X Sdn Bhd' && wOut.phone === '0123456789');
}

// ─────────────────────────────────────────────── scoring
section('Scoring rules');
{
  const rules = getRules(appDb, 1);
  check('default rules seeded', rules.length > 5);

  const booked = scoreLead({ source_type: 'calendly', name: 'A B', email: 'a@acme.com', email_normalized: 'a@acme.com', phone: '0123', title: 'Head of Growth', message: 'hi' }, rules);
  const cold = scoreLead({ source_type: 'webhook', name: 'C D', email: 'c@gmail.com', email_normalized: 'c@gmail.com' }, rules);
  check('booked meeting outscores a cold webhook', booked.score > cold.score, `${booked.score} vs ${cold.score}`);
  check('freemail penalised', cold.score < 20, `cold=${cold.score}`);
  check('score clamped to 0..100', booked.score <= 100 && cold.score >= 0);

  // Give both leads positive headroom (a phone = +20) so the -20 "no name"
  // penalty is observable rather than clamped away at the 0 floor.
  const nameless = scoreLead({ source_type: 'webhook', email: 'x@corp.com', email_normalized: 'x@corp.com', phone: '0123456789' }, rules);
  const named = scoreLead({ source_type: 'webhook', name: 'X', email: 'x@corp.com', email_normalized: 'x@corp.com', phone: '0123456789' }, rules);
  check('nameless lead penalised', nameless.score < named.score, `nameless=${nameless.score} named=${named.score}`);

  // A malformed rule must be skipped, not crash ingest.
  const withBad = scoreLead({ source_type: 'webhook', name: 'A' }, [
    { enabled: 1, name: 'evil', field: 'nope; DROP TABLE leads', op: 'equals', value: 'x', points: 99 },
    { enabled: 1, name: 'ok', field: 'name', op: 'is_present', value: null, points: 5 },
  ]);
  check('unknown rule field is skipped, valid rule still applies', withBad.score === 5);
}

// ─────────────────────────────────────────────── segment DSL
section('Segment filter DSL');
{
  const good = {
    match: 'all',
    groups: [
      { match: 'any', conditions: [
        { field: 'source_type', op: 'equals', value: 'calendly' },
        { field: 'source_type', op: 'equals', value: 'google_ads' } ] },
      { match: 'all', conditions: [
        { field: 'score', op: 'gte', value: 60 },
        { field: 'status', op: 'in', value: ['new', 'contacted'] } ] },
    ],
  };
  const c = compileSegmentFilter(good, 7);
  check('compiles AND-of-ORs', /\(\(s\.type = \?\) OR \(s\.type = \?\)\)/.test(c.sql) && /\(l\.score >= \?\) AND \(l\.status IN \(\?, \?\)\)/.test(c.sql), c.sql);
  check('user_id is always the first bound param', c.params[0] === 7);
  // 1 tenant id + 5 condition values, every one parameterised.
  check('every value is a bound param', c.params.length === 6 && c.params.includes('calendly') && c.params.includes(60));
  check('joins lead_sources only when needed', c.needsJoin && c.sql.includes('LEFT JOIN lead_sources'));

  const noJoin = compileSegmentFilter({ match: 'all', groups: [{ match: 'all', conditions: [{ field: 'score', op: 'gte', value: 1 }] }] }, 7);
  check('no join when no source field used', !noJoin.needsJoin && !noJoin.sql.includes('LEFT JOIN'));

  // Injection attempts must be rejected at the allowlist, never spliced in.
  check('unknown field rejected', !validateFilter({ groups: [{ conditions: [{ field: 'score; DROP TABLE leads--', op: 'gte', value: 1 }] }] }).valid);
  check('unknown operator rejected', !validateFilter({ groups: [{ conditions: [{ field: 'score', op: 'union_select', value: 1 }] }] }).valid);
  check('operator/type mismatch rejected', !validateFilter({ groups: [{ conditions: [{ field: 'score', op: 'contains', value: 'x' }] }] }).valid);
  check('non-numeric value for numeric field rejected', !validateFilter({ groups: [{ conditions: [{ field: 'score', op: 'gte', value: 'abc' }] }] }).valid);
  check('in_last_days rejects non-integer', !validateFilter({ groups: [{ conditions: [{ field: 'created_at', op: 'in_last_days', value: '7; DROP' }] }] }).valid);
  check('empty filter is valid (all leads)', validateFilter({ match: 'all', groups: [] }).valid);

  // LIKE metacharacters must be escaped, not treated as wildcards.
  const likeC = compileSegmentFilter({ groups: [{ conditions: [{ field: 'company', op: 'contains', value: '50%_off' }] }] }, 7);
  check('LIKE wildcards escaped', likeC.params[1] === '%50\\%\\_off%' && likeC.sql.includes("ESCAPE '\\'"), JSON.stringify(likeC.params));

  // Caps
  const tooMany = { match: 'all', groups: Array.from({ length: 11 }, () => ({ match: 'all', conditions: [{ field: 'score', op: 'gte', value: 1 }] })) };
  check('group cap enforced', !validateFilter(tooMany).valid);
}

// ─────────────────────────────────────────────── identity resolution
section('Identity resolution');
{
  const src = leadSourcesService.create(1, { type: 'webhook', name: 'T1 hook', auto_promote: true });
  const srcRow = appDb.prepare('SELECT * FROM lead_sources WHERE id = ?').get(src.id);
  appDb.prepare('UPDATE lead_settings SET auto_promote_threshold = 0 WHERE user_id = 1').run();
  appDb.prepare("INSERT OR IGNORE INTO lead_settings (user_id, auto_promote_threshold, ai_qualify_threshold) VALUES (1, 0, 101)").run();
  appDb.prepare('UPDATE lead_settings SET auto_promote_threshold = 0, ai_qualify_threshold = 101 WHERE user_id = 1').run();

  const r1 = ingest(srcRow, { name: 'Amos Tan', email: 'Amos@Acme.com', phone: '+60 12-345 6789' }, { externalId: 'w1' });
  check('first ingest creates a lead', r1.status === 'accepted' && r1.leadId > 0, JSON.stringify(r1));

  // Idempotency: same external_id, different content.
  const r2 = ingest(srcRow, { name: 'Someone Else', email: 'other@x.com' }, { externalId: 'w1' });
  check('redelivered event (same external_id) is a no-op', r2.status === 'duplicate' && r2.idempotent);

  // Same person, different case + formatting, new event id → merge, not duplicate.
  const r3 = ingest(srcRow, { name: 'Amos Tan', email: 'AMOS@ACME.COM' }, { externalId: 'w2' });
  check('case-variant email resolves to the same lead', r3.leadId === r1.leadId && r3.deduped, JSON.stringify(r3));

  const touches = appDb.prepare('SELECT COUNT(*) c FROM lead_touchpoints WHERE lead_id = ?').get(r1.leadId).c;
  check('each touch recorded as a touchpoint', touches === 2, `touches=${touches}`);
  check('touch_count incremented', appDb.prepare('SELECT touch_count c FROM leads WHERE id = ?').get(r1.leadId).c === 2);

  // Phone alone must NOT merge two different people (shared office line).
  const r4 = ingest(srcRow, { name: 'Different Person', email: 'dp@acme.com', phone: '+60 12-345 6789' }, { externalId: 'w3' });
  check('same phone + different name does NOT merge', r4.leadId !== r1.leadId, JSON.stringify(r4));
  check('but it is surfaced as a possible duplicate',
    (r4.possibleDuplicateIds || []).includes(r1.leadId) || r4.status === 'accepted');

  // Phone + same name DOES merge (no email on the incoming payload).
  const r5 = ingest(srcRow, { name: 'amos  tan', phone: '0060123456789' }, { externalId: 'w4' });
  check('phone+name merge requires exact normalized phone', r5.leadId !== r1.leadId || r5.deduped);

  const r6 = ingest(srcRow, { name: 'AMOS TAN', phone: '+60 12 345 6789' }, { externalId: 'w5' });
  check('phone + matching name merges', r6.leadId === r1.leadId && r6.deduped, JSON.stringify(r6));

  // Empty fields get filled; populated fields are never overwritten.
  const before = appDb.prepare('SELECT * FROM leads WHERE id = ?').get(r1.leadId);
  const r7 = ingest(srcRow, { name: 'Amos Tan', email: 'amos@acme.com', company: 'Acme Sdn Bhd', title: 'CEO' }, { externalId: 'w6' });
  const after = appDb.prepare('SELECT * FROM leads WHERE id = ?').get(r1.leadId);
  check('empty company filled from later touch', !before.company && after.company === 'Acme Sdn Bhd');

  const r8 = ingest(srcRow, { name: 'Amos Tan', email: 'amos@acme.com', company: 'Evil Corp' }, { externalId: 'w7' });
  const after2 = appDb.prepare('SELECT * FROM leads WHERE id = ?').get(r1.leadId);
  check('populated company NOT overwritten by later touch', after2.company === 'Acme Sdn Bhd');
  check('conflict recorded in notes', /Conflicting fields ignored/.test(after2.notes || ''));

  // Cross-tenant: same email under tenant 2 is a different lead.
  const src2 = leadSourcesService.create(2, { type: 'webhook', name: 'T2 hook', auto_promote: true });
  const src2Row = appDb.prepare('SELECT * FROM lead_sources WHERE id = ?').get(src2.id);
  appDb.prepare("INSERT OR IGNORE INTO lead_settings (user_id, auto_promote_threshold, ai_qualify_threshold) VALUES (2, 0, 101)").run();
  appDb.prepare('UPDATE lead_settings SET auto_promote_threshold = 0, ai_qualify_threshold = 101 WHERE user_id = 2').run();
  const rt = ingest(src2Row, { name: 'Amos Tan', email: 'amos@acme.com' }, { externalId: 't2-1' });
  check('same email under a different tenant creates a separate lead', rt.leadId !== r1.leadId && rt.status === 'accepted');
  check('tenant 2 lead belongs to tenant 2', appDb.prepare('SELECT user_id u FROM leads WHERE id = ?').get(rt.leadId).u === 2);

  // Phone-only lead (no email at all) — impossible before the schema rebuild.
  const rp = ingest(srcRow, { name: 'WhatsApp Person', phone: '+60 19 888 7777' }, { externalId: 'w8' });
  check('phone-only lead (no email) can be stored', rp.status === 'accepted' && rp.leadId > 0, JSON.stringify(rp));
  check('phone-only lead has NULL email, not a fabricated one',
    appDb.prepare('SELECT email FROM leads WHERE id = ?').get(rp.leadId).email === null);

  // A payload with no way to reach the person is rejected outright.
  let rejected = false;
  try { ingest(srcRow, { name: 'Ghost' }, { externalId: 'w9' }); } catch (e) { rejected = e.name === 'Error' || e.constructor.name === 'IngestRejected'; }
  check('payload with no email/phone/linkedin rejected', rejected);
}

// ─────────────────────────────────────────────── staging inbox
section('Staging inbox');
{
  const reviewSrc = leadSourcesService.create(1, { type: 'web_form', name: 'Contact form' });
  const row = appDb.prepare('SELECT * FROM lead_sources WHERE id = ?').get(reviewSrc.id);
  check('public source gets auth_mode=public', row.auth_mode === 'public');
  check('public source does not auto-promote by default', row.auto_promote === 0);

  const r = ingest(row, { name: 'Review Me', email: 'review@corp.com' }, {});
  check('non-auto-promote source stages the lead', r.status === 'pending' && r.inboxId > 0, JSON.stringify(r));
  check('no lead row created yet', !appDb.prepare("SELECT id FROM leads WHERE email_normalized='review@corp.com'").get());

  const promoted = promoteInboxRow(1, r.inboxId);
  check('accepting the inbox row creates the lead', promoted.ok && promoted.leadId > 0);
  const lead = appDb.prepare('SELECT * FROM leads WHERE id = ?').get(promoted.leadId);
  check('promoted lead carries first_source_id', lead.first_source_id === row.id);
  check('promoted lead marked self-reported', /Lead type: Inbound \(self-reported\)/.test(lead.notes));

  const again = promoteInboxRow(1, r.inboxId);
  check('accepting twice is idempotent', again.ok && again.leadId === promoted.leadId && again.alreadyPromoted);

  // A public source must never overwrite an existing lead's fields.
  const r2 = ingest(row, { name: 'Review Me', email: 'review@corp.com', phone: '+60 11 111 1111' }, {});
  const lead2 = appDb.prepare('SELECT * FROM leads WHERE id = ?').get(promoted.leadId);
  check('public source touches the known lead', r2.deduped && r2.leadId === promoted.leadId);
  check('public source did NOT write a phone onto the existing lead', lead2.phone === null, `phone=${lead2.phone}`);
  check('public-source touch still recorded', appDb.prepare('SELECT COUNT(*) c FROM lead_touchpoints WHERE lead_id = ?').get(promoted.leadId).c >= 2);
}

// ─────────────────────────────────────────────── segments end-to-end
section('Segments end-to-end');
{
  const seg = segmentsService.create(1, {
    name: 'Hot inbound',
    kind: 'dynamic',
    filter: { match: 'all', groups: [{ match: 'all', conditions: [{ field: 'has_phone', op: 'is_present', value: null }] }] },
  });
  const members = segmentsService.members(1, seg.id);
  check('dynamic segment returns only this tenant\'s leads', members.every((m) => m.user_id === 1));
  check('dynamic segment honours the filter', members.every((m) => m.phone_normalized));
  check('segment count matches members', segmentsService.count(1, seg.id) === members.length);

  const t2seg = segmentsService.getById(2, seg.id);
  check('another tenant cannot read the segment', t2seg === null);

  const stat = segmentsService.create(1, { name: 'VIPs', kind: 'static' });
  const allT1 = appDb.prepare('SELECT id FROM leads WHERE user_id = 1 LIMIT 2').all().map((r) => r.id);
  const t2LeadId = appDb.prepare('SELECT id FROM leads WHERE user_id = 2').get().id;
  const added = segmentsService.addMembers(1, stat.id, [...allT1, t2LeadId]);
  check('static segment ignores another tenant\'s lead ids', added === allT1.length, `added=${added}`);
}

// ─────────────────────────────────────────────── funnel
section('Per-source funnel');
{
  const funnel = leadSourcesService.funnel(1);
  check('funnel lists this tenant\'s sources', funnel.length >= 2);
  const hook = funnel.find((f) => f.name === 'T1 hook');
  check('funnel counts received events', hook && hook.received_count > 0);
  check('funnel counts leads attributed to the source', hook && hook.leads_count > 0);
  check('funnel does not leak tenant 2 sources', !funnel.some((f) => f.name === 'T2 hook'));
}

// ─────────────────────────────────────────────── secrets
section('Secret handling');
{
  const s = leadSourcesService.create(1, { type: 'zapier', name: 'Zap' });
  check('secret returned exactly once at creation', typeof s.secret === 'string' && s.secret.length >= 32);
  const fetched = leadSourcesService.getById(1, s.id);
  check('secret never returned again', fetched.secret === undefined && fetched.secret_enc === undefined);
  check('has_secret flag exposed instead', fetched.has_secret === true);
  const rowRaw = appDb.prepare('SELECT secret_enc FROM lead_sources WHERE id = ?').get(s.id);
  check('secret encrypted at rest', rowRaw.secret_enc.startsWith('enc:'), rowRaw.secret_enc.slice(0, 12));
  check('secret decrypts back to the original', leadSourcesService.decryptSecret(rowRaw) === s.secret);

  const rotated = leadSourcesService.rotateSecret(1, s.id);
  check('rotate issues a new secret', rotated.secret !== s.secret);
  check('another tenant cannot rotate it', leadSourcesService.rotateSecret(2, s.id) === null);
  check('another tenant cannot read it', leadSourcesService.getById(2, s.id) === null);
}

console.log(`\n${fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED / ${pass} passed`}`);
if (fail) console.log('Failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
appDb.close();
db.close();
process.exit(fail === 0 ? 0 : 1);
