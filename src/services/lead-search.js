/**
 * "Find decision-makers" on the Brief: one search run from who the account
 * sells to. Up to 15 people a run, never more than the month's remaining
 * allowance. Only verified people are kept (the gate in ai-agent.js
 * generateLeads*); everyone else is discarded, not stored, and reported back
 * with the reason.
 *
 * Kept leads go into the account's "Outreach from your Brief" campaign so the
 * approval queue and Launch work on them straight away. That campaign has no
 * audience of its own, so it always searches with the brief as it is now.
 */
import db from '../db/index.js';
import { runAgent } from './ai-agent.js';
import { getProfile, hasMarket, audienceFromBrief } from './account-profile.js';
import { checkPlanLimitForUser, remainingMonthlyAiLeads, getPlanLimits } from '../middleware/auth.js';

export const BRIEF_CAMPAIGN = 'Outreach from your Brief';
const MAX_PER_RUN = 15;

export class SearchRefused extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** The account's brief campaign, created on first use if the plan allows one more. */
export function ensureBriefCampaign(user) {
  const existing = db.prepare(`
    SELECT id FROM campaigns WHERE user_id = ? AND name = ? AND status NOT IN ('stopped', 'completed')
     ORDER BY id DESC LIMIT 1
  `).get(user.id, BRIEF_CAMPAIGN);
  if (existing) return existing.id;
  try { checkPlanLimitForUser(user, 'campaigns'); } catch { return null; }
  return db.prepare(`INSERT INTO campaigns (user_id, name, type, status, subject) VALUES (?, ?, 'email', 'draft', ?)`)
    .run(user.id, BRIEF_CAMPAIGN, BRIEF_CAMPAIGN).lastInsertRowid;
}

export async function findFromBrief(user, { count } = {}) {
  for (const resource of ['auto_leads', 'ai_leads_per_month', 'ai_action']) {
    try { checkPlanLimitForUser(user, resource); } catch (e) { throw new SearchRefused(e.message, 403); }
  }
  const profile = getProfile(user.id);
  if (!hasMarket(profile)) {
    throw new SearchRefused('Add who you sell to on your Brief first: your ideal client, or the decision-makers to find.', 400);
  }

  const requested = Math.max(1, parseInt(count, 10) || MAX_PER_RUN);
  const n = Math.min(MAX_PER_RUN, requested, remainingMonthlyAiLeads(user));
  const campaignId = ensureBriefCampaign(user);

  const r = await runAgent(user.id, 'generate_leads', {
    campaignId, campaignName: BRIEF_CAMPAIGN, targetAudience: audienceFromBrief(profile), count: n,
  });

  const limit = user.role === 'superadmin' ? null : getPlanLimits(user.plan).ai_leads_per_month;
  const remaining = remainingMonthlyAiLeads(user);
  return {
    found: (r.generated || 0) + (r.reused || 0) + (r.rejected || 0),
    kept: r.generated || 0,
    already_in_list: r.reused || 0,
    discarded: r.rejected || 0,
    // Names and reasons only: a discarded person's contact details are not
    // kept, and are not handed back either.
    discarded_list: (r.rejectedLeads || []).map(d => ({ name: d.name || '', reason: d.reason || '' })),
    lead_ids: (r.leads || []).map(l => l.id),
    used_this_month: limit === null ? null : limit - remaining,
    monthly_limit: limit,
    campaign_id: campaignId,
    provider: r.sourceProvider || null,
    apollo_error: r.apolloError || null,
    message: r.message || null,
  };
}
