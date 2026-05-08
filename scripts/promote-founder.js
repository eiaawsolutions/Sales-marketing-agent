#!/usr/bin/env node
/**
 * Promote a user to superadmin in the production DB. Safe to run via
 * `railway run node scripts/promote-founder.js <email>` because it executes
 * inside the Railway container with access to the mounted volume DB.
 *
 * Idempotent: returns the user state whether or not it changed it.
 */
import db from '../src/db/index.js';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Usage: node scripts/promote-founder.js <email>');
  process.exit(1);
}

const before = db.prepare('SELECT id, username, email, role, plan, email_verified FROM users WHERE email = ?').get(email);
if (!before) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}

console.log('BEFORE:', JSON.stringify(before, null, 2));

db.prepare(`
  UPDATE users
     SET role = 'superadmin',
         email_verified = 1,
         plan = 'business',
         updated_at = CURRENT_TIMESTAMP
   WHERE id = ?
`).run(before.id);

const after = db.prepare('SELECT id, username, email, role, plan, email_verified FROM users WHERE email = ?').get(email);
console.log('AFTER:', JSON.stringify(after, null, 2));
console.log(`\nUser ${email} promoted to superadmin (plan=business, email_verified=1).`);
