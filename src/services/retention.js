import defaultDb from '../db/index.js';
import { isFounderHq } from '../config/hq.js';

/**
 * Retention jobs behind the published promises (privacy notice §8, Terms §9,
 * DPA §10). Runs daily from services/scheduler.js.
 *
 *  1. Website enquiries and chat sign-ups are deleted 24 months after our last
 *     contact with the person, unless they became a customer.
 *  2. A customer account, and everything it owns, is deleted 90 days after its
 *     subscription ends.
 *
 * Both are idempotent: a second run finds nothing left to delete. Logs carry
 * counts only, never names or email addresses. Dry-run (RETENTION_DRY_RUN=1,
 * or `node scripts/run-retention.js --dry-run`) reports the counts without
 * deleting anything.
 *
 * Known gap (stated on the privacy page too): the account clock starts from
 * the `subscription_ended_<userId>` marker that the Stripe
 * customer.subscription.deleted webhook writes (routes/billing.js). Accounts
 * whose subscription ended before that marker existed, or that were closed
 * outside Stripe (admin suspension, founder comp), have no marker and are NOT
 * deleted automatically. The job logs how many suspended accounts lack a
 * marker so they can be reviewed and removed by hand with
 * scripts/delete-user.js.
 */

export const ENQUIRY_RETENTION_MONTHS = 24;
export const ACCOUNT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Inbound enquiries are the leads written by saveInboundLead() in
// routes/forms.js: source `contact_form_<site>` or `chatbot_<site>` AND the
// notes signature that function writes. Matching both means a customer's own
// lead that happens to carry a similar source label is never touched.
const INBOUND_NOTES_PREFIX = 'Lead type: Inbound (self-reported via website';

// Per-user settings rows (key = `<prefix><userId>`), removed with the account.
const USER_SETTINGS_PREFIXES = [
  'stripe_customer_', 'stripe_subscription_', 'verify_code_', 'verify_resend_',
  'trial_end_', 'reveal_addon_', 'ai_addon_', 'voice_addon_', 'cancel_pending_',
  'subscription_ended_', 'terms_acceptance_',
];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function subtractMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

// ---------------------------------------------------------------------------
// 1. Enquiries and chat sign-ups
// ---------------------------------------------------------------------------

// "Last contact" is the latest timestamp we hold for the person: the lead row
// itself, any activity, campaign delivery, appointment (including one booked
// in the future), touchpoint, form submission or queued outreach. Taking the
// latest of all of them errs towards keeping data a little longer, never
// deleting early.
export function findStaleEnquiries(db, now = new Date()) {
  const cutoff = subtractMonths(now, ENQUIRY_RETENTION_MONTHS).toISOString();
  const has = (t) => tableExists(db, t);
  const parts = [
    'julianday(l.created_at)',
    'COALESCE(julianday(l.updated_at), 0)',
    'COALESCE((SELECT MAX(julianday(a.created_at)) FROM activities a WHERE a.lead_id = l.id), 0)',
    `COALESCE((SELECT MAX(MAX(COALESCE(julianday(cl.sent_at), 0), COALESCE(julianday(cl.opened_at), 0), COALESCE(julianday(cl.clicked_at), 0)))
                 FROM campaign_leads cl WHERE cl.lead_id = l.id), 0)`,
    `COALESCE((SELECT MAX(MAX(COALESCE(julianday(ap.scheduled_at), 0), COALESCE(julianday(ap.updated_at), 0), COALESCE(julianday(ap.created_at), 0)))
                 FROM appointments ap WHERE ap.lead_id = l.id), 0)`,
    `COALESCE((SELECT MAX(MAX(COALESCE(julianday(oq.sent_at), 0), COALESCE(julianday(oq.scheduled_at), 0), COALESCE(julianday(oq.created_at), 0)))
                 FROM outreach_queue oq WHERE oq.lead_id = l.id), 0)`,
    'COALESCE((SELECT MAX(julianday(fs.submitted_at)) FROM form_submissions fs WHERE fs.lead_id = l.id), 0)',
  ];
  if (has('lead_touchpoints')) {
    parts.push('COALESCE((SELECT MAX(julianday(tp.occurred_at)) FROM lead_touchpoints tp WHERE tp.lead_id = l.id), 0)');
  }

  return db.prepare(`
    SELECT l.id FROM leads l
     WHERE (l.source LIKE 'contact\\_form\\_%' ESCAPE '\\' OR l.source LIKE 'chatbot\\_%' ESCAPE '\\')
       AND l.notes LIKE ? || '%'
       AND COALESCE(l.status, '') <> 'won'
       AND julianday(l.created_at) IS NOT NULL
       AND (l.email IS NULL OR lower(trim(l.email)) NOT IN (SELECT lower(trim(email)) FROM users))
       AND MAX(${parts.join(',\n           ')}) < julianday(?)
  `).all(INBOUND_NOTES_PREFIX, cutoff).map((r) => r.id);
}

// Deletes every row that points at the lead(s) selected by leadIdsSql (which
// may use the named parameters in `params`). Caller wraps it in a transaction.
function deleteLeadRows(db, leadIdsSql, params) {
  const run = (sql) => db.prepare(sql).run(params).changes;
  let n = 0;
  n += run(`DELETE FROM form_submissions WHERE lead_id IN (${leadIdsSql})`);
  n += run(`DELETE FROM outreach_queue WHERE lead_id IN (${leadIdsSql})`);
  n += run(`DELETE FROM campaign_leads WHERE lead_id IN (${leadIdsSql})`);
  n += run(`DELETE FROM appointments WHERE lead_id IN (${leadIdsSql})`);
  n += run(`DELETE FROM activities WHERE lead_id IN (${leadIdsSql})`);
  n += run(`DELETE FROM pipeline WHERE lead_id IN (${leadIdsSql})`);
  if (tableExists(db, 'lead_touchpoints')) n += run(`DELETE FROM lead_touchpoints WHERE lead_id IN (${leadIdsSql})`);
  if (tableExists(db, 'segment_members')) n += run(`DELETE FROM segment_members WHERE lead_id IN (${leadIdsSql})`);
  if (tableExists(db, 'lead_inbox')) {
    n += run(`DELETE FROM lead_inbox WHERE promoted_lead_id IN (${leadIdsSql}) OR matched_lead_id IN (${leadIdsSql})`);
  }
  return n;
}

export function deleteEnquiries(db, leadIds) {
  let leads = 0;
  let related = 0;
  const tx = db.transaction((id) => {
    related += deleteLeadRows(db, 'SELECT @id', { id });
    leads += db.prepare('DELETE FROM leads WHERE id = @id').run({ id }).changes;
  });
  for (const id of leadIds) tx(id);
  return { leads, related };
}

// ---------------------------------------------------------------------------
// 2. Accounts after the subscription ends
// ---------------------------------------------------------------------------

// Returns { expired: [userId], reinstated: [userId], orphaned: [settingsKey],
// unmarked: <count> }.
export function findExpiredAccounts(db, now = new Date()) {
  const markers = db.prepare(
    "SELECT key, value FROM settings WHERE key LIKE 'subscription\\_ended\\_%' ESCAPE '\\'",
  ).all();
  const expired = [];
  const reinstated = [];
  const orphaned = [];
  for (const m of markers) {
    const userId = Number(m.key.slice('subscription_ended_'.length));
    const user = Number.isInteger(userId)
      ? db.prepare('SELECT id, email, role, status FROM users WHERE id = ?').get(userId)
      : null;
    if (!user) { orphaned.push(m.key); continue; }
    // Never the operator account, never a superadmin.
    if (isFounderHq(user.email) || user.role === 'superadmin') { reinstated.push(user.id); continue; }
    // Resubscribed or reinstated by an admin: the clock no longer runs.
    if (user.status !== 'suspended') { reinstated.push(user.id); continue; }
    const endedAt = Date.parse(m.value);
    if (Number.isNaN(endedAt)) continue; // unreadable marker: keep, review by hand
    if (now.getTime() - endedAt >= ACCOUNT_RETENTION_DAYS * DAY_MS) expired.push(user.id);
  }
  const unmarked = db.prepare(`
    SELECT COUNT(*) AS c FROM users u
     WHERE u.status = 'suspended'
       AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'subscription_ended_' || u.id)
  `).get().c;
  return { expired, reinstated, orphaned, unmarked };
}

// Deletes one account and everything it owns, all-or-nothing. Billing records
// stay in Stripe (7 years, privacy notice §8); the Stripe acceptance metadata
// stays with them.
export function deleteAccountData(db, userId) {
  const uid = { uid: userId };
  const LEADS = 'SELECT id FROM leads WHERE user_id = @uid';
  const CAMPAIGNS = 'SELECT id FROM campaigns WHERE user_id = @uid';
  const counts = {};
  const run = (label, sql) => { counts[label] = (counts[label] || 0) + db.prepare(sql).run(uid).changes; };

  const tx = db.transaction(() => {
    run('form_submissions', `DELETE FROM form_submissions WHERE form_id IN (SELECT id FROM forms WHERE user_id = @uid) OR lead_id IN (${LEADS})`);
    run('forms', 'DELETE FROM forms WHERE user_id = @uid');
    run('outreach_queue', `DELETE FROM outreach_queue WHERE user_id = @uid OR campaign_id IN (${CAMPAIGNS}) OR lead_id IN (${LEADS})`);
    run('campaign_leads', `DELETE FROM campaign_leads WHERE campaign_id IN (${CAMPAIGNS}) OR lead_id IN (${LEADS})`);
    run('appointments', `DELETE FROM appointments WHERE user_id = @uid OR lead_id IN (${LEADS})`);
    run('activities', `DELETE FROM activities WHERE user_id = @uid OR lead_id IN (${LEADS}) OR campaign_id IN (${CAMPAIGNS})`);
    run('pipeline', `DELETE FROM pipeline WHERE user_id = @uid OR lead_id IN (${LEADS})`);
    run('generated_content', `DELETE FROM generated_content WHERE user_id = @uid OR campaign_id IN (${CAMPAIGNS})`);
    run('ai_cost_log', `DELETE FROM ai_cost_log WHERE user_id = @uid OR campaign_id IN (${CAMPAIGNS})`);
    if (tableExists(db, 'lead_touchpoints')) run('lead_touchpoints', `DELETE FROM lead_touchpoints WHERE user_id = @uid OR lead_id IN (${LEADS})`);
    if (tableExists(db, 'segment_members')) run('segment_members', `DELETE FROM segment_members WHERE lead_id IN (${LEADS}) OR segment_id IN (SELECT id FROM segments WHERE user_id = @uid)`);
    if (tableExists(db, 'segments')) run('segments', 'DELETE FROM segments WHERE user_id = @uid');
    if (tableExists(db, 'lead_inbox')) run('lead_inbox', 'DELETE FROM lead_inbox WHERE user_id = @uid');
    run('leads', 'DELETE FROM leads WHERE user_id = @uid');
    run('campaigns', 'DELETE FROM campaigns WHERE user_id = @uid');
    if (tableExists(db, 'lead_sources')) run('lead_sources', 'DELETE FROM lead_sources WHERE user_id = @uid');
    if (tableExists(db, 'lead_scoring_rules')) run('lead_scoring_rules', 'DELETE FROM lead_scoring_rules WHERE user_id = @uid');
    if (tableExists(db, 'lead_settings')) run('lead_settings', 'DELETE FROM lead_settings WHERE user_id = @uid');
    run('agent_tasks', 'DELETE FROM agent_tasks WHERE user_id = @uid');
    run('sessions', 'DELETE FROM sessions WHERE user_id = @uid');
    const delSetting = db.prepare('DELETE FROM settings WHERE key = ?');
    counts.settings = 0;
    for (const p of USER_SETTINGS_PREFIXES) counts.settings += delSetting.run(`${p}${userId}`).changes;
    run('users', 'DELETE FROM users WHERE id = @uid');
  });
  tx();
  return counts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function runRetention({ db = defaultDb, now = new Date(), dryRun = false, log = console } = {}) {
  const mode = dryRun ? 'DRY RUN' : 'live';
  const summary = { dryRun, enquiriesDeleted: 0, enquiryRelatedRows: 0, accountsDeleted: 0, accountRows: 0,
    staleEnquiries: 0, expiredAccounts: 0, markersCleared: 0, suspendedWithoutMarker: 0 };

  const stale = findStaleEnquiries(db, now);
  summary.staleEnquiries = stale.length;

  const acc = findExpiredAccounts(db, now);
  summary.expiredAccounts = acc.expired.length;
  summary.suspendedWithoutMarker = acc.unmarked;

  if (!dryRun) {
    const e = deleteEnquiries(db, stale);
    summary.enquiriesDeleted = e.leads;
    summary.enquiryRelatedRows = e.related;

    for (const userId of acc.expired) {
      const counts = deleteAccountData(db, userId);
      summary.accountsDeleted += counts.users || 0;
      summary.accountRows += Object.values(counts).reduce((a, b) => a + b, 0);
    }

    const clear = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const userId of acc.reinstated) summary.markersCleared += clear.run(`subscription_ended_${userId}`).changes;
    for (const key of acc.orphaned) summary.markersCleared += clear.run(key).changes;
  }

  log.log(`[Retention] ${mode}: enquiries past ${ENQUIRY_RETENTION_MONTHS} months = ${summary.staleEnquiries}`
    + (dryRun ? '' : ` (deleted ${summary.enquiriesDeleted}, related rows ${summary.enquiryRelatedRows})`)
    + `; accounts ${ACCOUNT_RETENTION_DAYS}+ days after subscription end = ${summary.expiredAccounts}`
    + (dryRun ? '' : ` (deleted ${summary.accountsDeleted}, rows ${summary.accountRows}, stale markers cleared ${summary.markersCleared})`)
    + `; suspended accounts with no end marker (manual review) = ${summary.suspendedWithoutMarker}`);
  return summary;
}
