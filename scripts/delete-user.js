#!/usr/bin/env node
/**
 * Delete a user and all of their user-scoped data from the production DB.
 *
 * Run via:
 *   railway run --service Sales-marketing-agent node scripts/delete-user.js <email>
 *
 * Refuses to delete superadmins — pass DELETE_SUPERADMIN=YES to override
 * (you almost certainly don't want this).
 *
 * Also drops user-scoped settings rows keyed on the user id (stripe, trial,
 * temp pass, addons, etc.) so re-signup works cleanly.
 *
 * IRREVERSIBLE. The user is gone after this.
 */
import db from '../src/db/index.js';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Usage: node scripts/delete-user.js <email>');
  process.exit(1);
}

const user = db.prepare('SELECT id, username, email, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}

if (user.role === 'superadmin' && process.env.DELETE_SUPERADMIN !== 'YES') {
  console.error(`Refusing to delete superadmin ${email}. Override with DELETE_SUPERADMIN=YES.`);
  process.exit(1);
}

// FK-safe order: kill children before the parent users row. Mirrors the order
// in scripts/purge-and-reset.js. form_submissions → forms is the only deeper
// chain; everything else is one hop from users.
const childTables = [
  'form_submissions',
  'forms',
  'sessions',
  'ai_cost_log',
  'generated_content',
  'outreach_queue',
  'campaign_leads',
  'appointments',
  'activities',
  'pipeline',
  'campaigns',
  'leads',
  'agent_tasks',
];

// User-scoped settings keys (per-user suffix). Pattern: '<key>_<userId>'.
const userScopedSettingsLike = [
  `stripe_customer_${user.id}`,
  `stripe_subscription_${user.id}`,
  `verify_code_${user.id}`,
  `temp_pass_${user.id}`,
  `trial_end_${user.id}`,
  `reveal_addon_${user.id}`,
  `reveal_granted_${user.id}`,
  `ai_addon_${user.id}`,
  `ai_credit_granted_${user.id}`,
];

console.log('=== DELETE USER ===');
console.log(`Target: ${user.username} <${user.email}> (id=${user.id}, role=${user.role})`);

const tx = db.transaction(() => {
  for (const t of childTables) {
    try {
      // Most child tables key on user_id; form_submissions keys on form_id
      // which keys on user_id. Handle both via try/catch so a missing column
      // skips rather than aborts.
      let r;
      if (t === 'form_submissions') {
        r = db.prepare(`
          DELETE FROM form_submissions
           WHERE form_id IN (SELECT id FROM forms WHERE user_id = ?)
        `).run(user.id);
      } else {
        r = db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id);
      }
      if (r.changes > 0) console.log(`  ${t}: ${r.changes} rows`);
    } catch (e) {
      console.warn(`  skip ${t}: ${e.message}`);
    }
  }

  for (const key of userScopedSettingsLike) {
    const r = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    if (r.changes > 0) console.log(`  settings ${key}: removed`);
  }

  const r = db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  console.log(`  users: ${r.changes} row`);
});

tx();

console.log('\n=== DELETE COMPLETE ===');

const remaining = db.prepare('SELECT id, username, email, role FROM users ORDER BY id').all();
console.log(`Remaining users: ${remaining.length}`);
for (const u of remaining) console.log(`  ${JSON.stringify(u)}`);
