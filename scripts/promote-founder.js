#!/usr/bin/env node
/**
 * Promote a user to superadmin in the production DB. Safe to run via
 * `railway run node scripts/promote-founder.js <email>` because it executes
 * inside the Railway container with access to the mounted volume DB.
 *
 * Idempotent: returns the user state whether or not it changed it.
 */
import db from '../src/db/index.js';
import { FOUNDER_HQ_EMAIL, isFounderHq } from '../src/config/hq.js';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Usage: node scripts/promote-founder.js <email>');
  process.exit(1);
}

// Invariant: only the HQ / Founder account may be a superadmin.
if (!isFounderHq(email)) {
  console.error(`Refusing to promote ${email}: only the HQ account (${FOUNDER_HQ_EMAIL}) can be a superadmin.`);
  console.error('Set FOUNDER_HQ_EMAIL if the HQ address differs in this environment.');
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
