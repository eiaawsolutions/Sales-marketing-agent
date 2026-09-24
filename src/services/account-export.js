/**
 * Customer data export (Terms §9, DPA §10, privacy notice §10).
 *
 * There is no self-serve export in the app; the published promise is an export
 * on request, by email, within 14 days. RUNBOOK:
 *
 *   1. Take the request only from the account owner's email address (or verify
 *      identity another way). Log the request date: the 14 days start then.
 *   2. Produce the file:
 *        railway run --service Sales-marketing-agent \
 *          node scripts/export-account.js <owner-email> > export.json
 *      (locally: SA_DB_PATH=<copy of the db> node scripts/export-account.js ...)
 *   3. Check the file opens and the counts in "summary" look right. If the
 *      customer asked for CSV, convert the "leads" array (one row per lead).
 *   4. Send it to the owner's email address only, as an encrypted archive or a
 *      share link that expires. Delete local copies once it is delivered.
 *   5. Reply within 14 days of the request, and note the date sent.
 *
 * Secrets never leave: password hashes, MFA secrets and recovery codes,
 * ingest keys and connector secrets are left out.
 */

const USER_FIELDS = ['id', 'username', 'email', 'display_name', 'role', 'plan', 'status', 'email_verified', 'created_at', 'updated_at'];
const LEAD_SOURCE_SECRET_FIELDS = new Set(['ingest_key', 'secret_enc']);

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function exportAccountData(db, userId) {
  const user = db.prepare(`SELECT ${USER_FIELDS.join(', ')} FROM users WHERE id = ?`).get(userId);
  if (!user) return null;

  const uid = { uid: userId };
  const LEADS = 'SELECT id FROM leads WHERE user_id = @uid';
  const CAMPAIGNS = 'SELECT id FROM campaigns WHERE user_id = @uid';
  const all = (sql) => db.prepare(sql).all(uid);

  const data = {
    leads: all('SELECT * FROM leads WHERE user_id = @uid ORDER BY id'),
    activities: all(`SELECT * FROM activities WHERE user_id = @uid OR lead_id IN (${LEADS}) ORDER BY id`),
    pipeline: all(`SELECT * FROM pipeline WHERE user_id = @uid OR lead_id IN (${LEADS}) ORDER BY id`),
    appointments: all(`SELECT * FROM appointments WHERE user_id = @uid OR lead_id IN (${LEADS}) ORDER BY id`),
    campaigns: all('SELECT * FROM campaigns WHERE user_id = @uid ORDER BY id'),
    campaign_leads: all(`SELECT * FROM campaign_leads WHERE campaign_id IN (${CAMPAIGNS})`),
    outreach_queue: all(`SELECT * FROM outreach_queue WHERE campaign_id IN (${CAMPAIGNS}) OR lead_id IN (${LEADS}) ORDER BY id`),
    generated_content: all('SELECT * FROM generated_content WHERE user_id = @uid ORDER BY id'),
    forms: all('SELECT * FROM forms WHERE user_id = @uid ORDER BY id'),
    form_submissions: all('SELECT * FROM form_submissions WHERE form_id IN (SELECT id FROM forms WHERE user_id = @uid) ORDER BY id'),
  };
  if (tableExists(db, 'segments')) data.segments = all('SELECT * FROM segments WHERE user_id = @uid ORDER BY id');
  if (tableExists(db, 'segment_members')) {
    data.segment_members = all('SELECT * FROM segment_members WHERE segment_id IN (SELECT id FROM segments WHERE user_id = @uid)');
  }
  if (tableExists(db, 'lead_touchpoints')) data.lead_touchpoints = all('SELECT * FROM lead_touchpoints WHERE user_id = @uid ORDER BY id');
  if (tableExists(db, 'lead_sources')) {
    data.lead_sources = all('SELECT * FROM lead_sources WHERE user_id = @uid ORDER BY id').map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) if (!LEAD_SOURCE_SECRET_FIELDS.has(k)) out[k] = v;
      return out;
    });
  }

  // The do-not-email list holds hashes only (see db/schema-suppressions.js),
  // so that is what the export carries; the note says how to match them.
  data.email_suppressions = all(`SELECT email_hash, reason, campaign_id, lead_id, created_at
                                 FROM email_suppressions WHERE user_id = @uid ORDER BY id`);

  const summary = {};
  for (const [k, v] of Object.entries(data)) summary[k] = v.length;

  return {
    exported_at: new Date().toISOString(),
    format: 'EIAAW SalesAgent account export (JSON)',
    account: user,
    summary,
    notes: {
      email_suppressions: 'Your do-not-email list: recipients who unsubscribed, marked your email as spam, or were added manually. '
        + 'Addresses are stored only as SHA-256 hex of the address trimmed and lower-cased; hash your own list the same way to match them.',
    },
    data,
  };
}
