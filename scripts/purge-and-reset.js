#!/usr/bin/env node
/**
 * One-shot production purge — deletes ALL user-scoped data so the DB starts
 * fresh with Stripe Checkout as the only account-creation path.
 *
 * Tables wiped (in FK-safe order):
 *   sessions, outreach_queue, campaign_leads, ai_cost_log, agent_tasks,
 *   generated_content, activities, appointments, pipeline, campaigns, leads,
 *   forms, form_submissions, users
 *
 * Settings table is preserved BUT user-scoped settings rows are removed:
 *   stripe_customer_*, stripe_subscription_*, verify_code_*, temp_pass_*,
 *   trial_end_*, reveal_addon_*, reveal_granted_*, ai_addon_*,
 *   ai_credit_granted_*
 *
 * Platform config preserved: api_key, ai_model, ai_provider, smtp_*,
 *   from_email, stripe_secret_key, stripe_webhook_secret, stripe_publishable_key,
 *   stripe_price_*, voice_ai_*, apollo_api_key, resend_api_key, base_url,
 *   admin_password, ai_credit_balance.
 *
 * Run via: PURGE_CONFIRM=YES node scripts/purge-and-reset.js
 * The PURGE_CONFIRM=YES env guard is mandatory — without it, the script
 * dry-runs and shows what would be deleted without touching the DB.
 *
 * IRREVERSIBLE. NO BACKUP TAKEN. AUTHORIZED BY THE FOUNDER (2026-05-06).
 */
import db from '../src/db/index.js';

const DRY_RUN = process.env.PURGE_CONFIRM !== 'YES';

const userTables = [
  'sessions',
  'outreach_queue',
  'campaign_leads',
  'ai_cost_log',
  'agent_tasks',
  'generated_content',
  'activities',
  'appointments',
  'pipeline',
  'campaigns',
  'leads',
  'forms',
  'form_submissions',
  'users',
];

// Settings keys we DELETE (user-scoped). Anything not matching these patterns
// is platform config and stays put.
const userScopedSettingsLike = [
  'stripe_customer_%',
  'stripe_subscription_%',
  'verify_code_%',
  'temp_pass_%',
  'trial_end_%',
  'reveal_addon_%',
  'reveal_granted_%',
  'ai_addon_%',
  'ai_credit_granted_%',
];

function countAll() {
  const counts = {};
  for (const t of userTables) {
    try {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    } catch (e) {
      counts[t] = `(table missing: ${e.message})`;
    }
  }
  let settingsCount = 0;
  for (const pat of userScopedSettingsLike) {
    settingsCount += db.prepare('SELECT COUNT(*) AS c FROM settings WHERE key LIKE ?').get(pat).c;
  }
  counts.settings_user_scoped_rows = settingsCount;
  return counts;
}

console.log('=== EIAAW SalesAgent purge-and-reset ===');
console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'LIVE PURGE'}`);
console.log('Pre-purge row counts:');
console.log(JSON.stringify(countAll(), null, 2));

if (DRY_RUN) {
  console.log('\nDry-run only. To execute, re-run with PURGE_CONFIRM=YES');
  process.exit(0);
}

console.log('\n>>> EXECUTING PURGE <<<');

const tx = db.transaction(() => {
  // FK-safe order: kill children before parents.
  for (const t of userTables) {
    try {
      const r = db.prepare(`DELETE FROM ${t}`).run();
      console.log(`  DELETE FROM ${t}: ${r.changes} rows`);
    } catch (e) {
      console.error(`  FAILED on ${t}: ${e.message}`);
      throw e;
    }
  }
  // Reset autoincrement counters so new accounts start at id=1.
  for (const t of userTables) {
    try {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(t);
    } catch (_) { /* sqlite_sequence may not exist for tables w/o AUTOINCREMENT */ }
  }
  // Drop user-scoped settings rows.
  for (const pat of userScopedSettingsLike) {
    const r = db.prepare('DELETE FROM settings WHERE key LIKE ?').run(pat);
    if (r.changes > 0) console.log(`  settings LIKE '${pat}': ${r.changes} rows`);
  }
});

tx();

console.log('\nPost-purge row counts:');
console.log(JSON.stringify(countAll(), null, 2));
console.log('\n=== PURGE COMPLETE ===');
console.log('Next: founder signs up via /#pricing with FOUNDER_HQ coupon.');
console.log('After signup, promote to superadmin:');
console.log("  UPDATE users SET role = 'superadmin' WHERE email = 'eiaawsolutions@gmail.com';");
