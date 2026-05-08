#!/usr/bin/env node
/**
 * Reset a user's password to a freshly generated temporary value, print it
 * once to stdout, and exit. Bcrypt-hashed via the same path the app uses,
 * so the new password is fully compatible with /api/auth/login.
 *
 * Run via:
 *   railway run --service Sales-marketing-agent node scripts/reset-founder-password.js <email>
 *
 * The temp password is printed exactly once. Capture it from the terminal —
 * it is NOT stored anywhere recoverable. Sign in, then change it via
 * Settings → Account.
 */
import crypto from 'crypto';
import db from '../src/db/index.js';
import { hashPassword } from '../src/middleware/auth.js';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Usage: node scripts/reset-founder-password.js <email>');
  process.exit(1);
}

const user = db.prepare('SELECT id, username, email, role FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}

// 18 url-safe chars ≈ 108 bits of entropy — strong enough for a one-time
// handoff, short enough to type if needed.
const tempPassword = crypto.randomBytes(14).toString('base64url');
const hash = hashPassword(tempPassword);

db.prepare(`
  UPDATE users
     SET password_hash = ?,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = ?
`).run(hash, user.id);

// Also clear any active lockout/failure counters so the founder isn't blocked
// by a prior brute-force attempt. These columns exist on the users table per
// the auth-security service.
try {
  db.prepare(`
    UPDATE users
       SET failed_login_attempts = 0,
           locked_until = NULL
     WHERE id = ?
  `).run(user.id);
} catch (_) {
  // Columns may not exist on older schemas; non-fatal.
}

console.log('=== PASSWORD RESET ===');
console.log(`User:     ${user.username} <${user.email}> (id=${user.id}, role=${user.role})`);
console.log(`Temp pw:  ${tempPassword}`);
console.log('');
console.log('Sign in at the app, then change it via Settings → Account.');
console.log('This password is shown ONCE. Copy it now.');
