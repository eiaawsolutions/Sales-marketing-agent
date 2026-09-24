#!/usr/bin/env node
/**
 * Run the retention job once, outside the daily 03:15 MYT cron.
 *
 *   node scripts/run-retention.js --dry-run   # counts only, deletes nothing
 *   node scripts/run-retention.js             # deletes, same as the cron
 *
 * Against production:
 *   railway run --service Sales-marketing-agent node scripts/run-retention.js --dry-run
 *
 * Do a dry run before the first live run after a deploy, and check the
 * "suspended accounts with no end marker" count: those accounts are outside
 * the automatic 90-day deletion and need reviewing by hand
 * (scripts/delete-user.js).
 */
import { runRetention } from '../src/services/retention.js';

const dryRun = process.argv.includes('--dry-run') || process.env.RETENTION_DRY_RUN === '1';
const summary = runRetention({ dryRun });
console.log(JSON.stringify(summary, null, 2));
