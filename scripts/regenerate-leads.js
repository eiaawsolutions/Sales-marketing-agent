#!/usr/bin/env node
// One-shot backfill: run the verification-first lead generator for all
// active + draft campaigns belonging to the target user.
//
// Usage (on Railway):
//   railway ssh "node scripts/regenerate-leads.js <email> [count]"
//
// Defaults: email = eiaawsolutions@gmail.com, count = 10, statuses = active,draft

import db from '../src/db/index.js';
import { runAgent } from '../src/services/ai-agent.js';

const email = process.argv[2] || 'eiaawsolutions@gmail.com';
const count = parseInt(process.argv[3] || '10', 10);
const statuses = ['active', 'draft'];

const user = db.prepare('SELECT id, email, display_name FROM users WHERE email = ?').get(email);
if (!user) {
  console.error(`[regen] user not found: ${email}`);
  process.exit(1);
}

const placeholders = statuses.map(() => '?').join(',');
const campaigns = db.prepare(
  `SELECT id, name, status, target_audience FROM campaigns
   WHERE user_id = ? AND status IN (${placeholders})
   ORDER BY id`
).all(user.id, ...statuses);

console.log(`[regen] user=${user.email} (id=${user.id})`);
console.log(`[regen] ${campaigns.length} campaign(s) in [${statuses.join(', ')}]; count=${count}/each`);

if (!campaigns.length) {
  console.log('[regen] nothing to do'); process.exit(0);
}

// Anthropic Sonnet org rate limit is 30k input tokens/min. Web-search lead-gen
// burns ~20-25k in one call, so a 70s gap between campaigns keeps us clear.
const PACE_MS = parseInt(process.env.LEADGEN_PACE_MS || '300000', 10);

const summary = [];
let first = true;
for (const c of campaigns) {
  if (!first) {
    console.log(`[regen] pacing ${PACE_MS}ms for rate limit…`);
    await new Promise(r => setTimeout(r, PACE_MS));
  }
  first = false;
  process.stdout.write(`[regen] → #${c.id} ${c.name} (${c.status}) ... `);
  if (!c.target_audience) {
    console.log('SKIP (no target_audience)');
    summary.push({ id: c.id, name: c.name, skipped: 'no target_audience' });
    continue;
  }
  try {
    const r = await runAgent(user.id, 'generate_leads', {
      campaignId: c.id,
      campaignName: c.name,
      targetAudience: c.target_audience,
      count,
    });
    console.log(`generated=${r.generated} reused=${r.reused} rejected=${r.rejected}`);
    summary.push({
      id: c.id, name: c.name,
      generated: r.generated, reused: r.reused, rejected: r.rejected,
    });
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    summary.push({ id: c.id, name: c.name, error: e.message });
  }
}

console.log('\n[regen] summary:');
console.table(summary);
process.exit(0);
