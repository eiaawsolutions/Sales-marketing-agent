#!/usr/bin/env node
/**
 * Export one customer account's data as JSON to stdout, for export requests
 * (Terms §9: "we'll provide it within 14 days"). Full runbook in
 * src/services/account-export.js.
 *
 *   railway run --service Sales-marketing-agent node scripts/export-account.js <email> > export.json
 *
 * The output contains personal data. Don't commit it, paste it into chat or
 * leave it on disk after delivery.
 */
import db from '../src/db/index.js';
import { exportAccountData } from '../src/services/account-export.js';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Usage: node scripts/export-account.js <owner-email>');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
if (!user) {
  console.error('No account with that email.');
  process.exit(1);
}
process.stdout.write(JSON.stringify(exportAccountData(db, user.id), null, 2) + '\n');
