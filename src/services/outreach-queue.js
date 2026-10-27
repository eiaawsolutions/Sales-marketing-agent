/**
 * The approval step between the agent drafting outreach and anything being
 * sent. Drafts ('draft') are approved into the send queue ('pending'), edited
 * while still drafts, or skipped. Callers have already checked that the
 * campaign belongs to the user (routes/campaigns.js router.param).
 */
import db from '../db/index.js';
import { kickDispatch } from './outreach-dispatch.js';
import { runAgent } from './ai-agent.js';

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 20000;

function idList(values) {
  return Array.isArray(values) ? [...new Set(values.map(Number).filter(Number.isInteger))] : [];
}

/**
 * A lead or item filter, when one is given, must be a non-empty array of ids.
 * Anything else is rejected rather than read as "no filter", which would
 * approve every draft in the campaign.
 */
export function validIdFilter(values) {
  if (values === undefined || values === null) return true;
  return Array.isArray(values) && values.length > 0
    && values.every(v => (typeof v === 'number' || typeof v === 'string') && /^\d+$/.test(String(v)));
}

/**
 * Approve a campaign's drafts — all of them, or only some leads / items.
 * Each step is re-scheduled from the moment of approval (Day 0 now, Day 3 in
 * three days), so a draft that waited a week does not fire every step at once.
 */
export function approveDrafts({ campaignId, leadIds, itemIds, approvedBy }) {
  if (!validIdFilter(leadIds) || !validIdFilter(itemIds)) return 0;
  const leads = idList(leadIds);
  const items = idList(itemIds);
  const where = ['campaign_id = ?', "status = 'draft'"];
  const params = [approvedBy, campaignId];
  if (leads.length) { where.push(`lead_id IN (${leads.map(() => '?').join(',')})`); params.push(...leads); }
  if (items.length) { where.push(`id IN (${items.map(() => '?').join(',')})`); params.push(...items); }

  const { changes } = db.prepare(`
    UPDATE outreach_queue
       SET status = 'pending', approved_at = CURRENT_TIMESTAMP, approved_by = ?,
           scheduled_at = datetime('now', '+' || COALESCE(delay_days, 0) || ' days')
     WHERE ${where.join(' AND ')}
  `).run(...params);
  if (changes > 0) kickDispatch(campaignId);
  return changes;
}

/** Cancel everything not yet sent for the given leads in one campaign. */
export function skipLeads({ campaignId, leadIds }) {
  const leads = idList(leadIds);
  if (!leads.length) return 0;
  return db.prepare(`
    UPDATE outreach_queue SET status = 'skipped'
     WHERE campaign_id = ? AND status IN ('draft', 'pending')
       AND lead_id IN (${leads.map(() => '?').join(',')})
  `).run(campaignId, ...leads).changes;
}

/** Drafts waiting for approval across the account's campaigns. */
export function draftsWaiting(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
     WHERE c.user_id = ? AND oq.status = 'draft'
  `).get(userId).c;
}

/**
 * After the brief changes: rewrite every sequence nobody has approved yet, from
 * the brief as it is now. A lead with any step approved, sent or skipped keeps
 * its sequence as it is. Returns how many leads were redrafted.
 */
export async function redraftFromBrief(userId) {
  const rows = db.prepare(`
    SELECT oq.campaign_id, oq.lead_id FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
     WHERE c.user_id = ? AND c.status NOT IN ('stopped', 'completed')
     GROUP BY oq.campaign_id, oq.lead_id
    HAVING SUM(oq.status <> 'draft') = 0
  `).all(userId);
  const byCampaign = new Map();
  for (const r of rows) {
    if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, []);
    byCampaign.get(r.campaign_id).push(r.lead_id);
  }
  let leadsRedrafted = 0;
  for (const [campaignId, leadIds] of byCampaign) {
    const r = await runAgent(userId, 'auto_outreach', { campaignId, leadIds, replaceDrafts: true });
    leadsRedrafted += r.leadsProcessed || 0;
  }
  return { leads_redrafted: leadsRedrafted, campaigns: byCampaign.size };
}

/** Edit a draft's subject and/or body. Returns 'ok', 'not_found' or 'not_draft'. */
export function editDraft({ campaignId, itemId, subject, message }) {
  const row = db.prepare('SELECT status FROM outreach_queue WHERE id = ? AND campaign_id = ?').get(itemId, campaignId);
  if (!row) return 'not_found';
  if (row.status !== 'draft') return 'not_draft';
  const fields = [];
  const params = [];
  if (typeof subject === 'string') { fields.push('subject = ?'); params.push(subject.trim().slice(0, MAX_SUBJECT)); }
  if (typeof message === 'string' && message.trim()) { fields.push('message = ?'); params.push(message.slice(0, MAX_MESSAGE)); }
  if (!fields.length) return 'ok';
  db.prepare(`UPDATE outreach_queue SET ${fields.join(', ')} WHERE id = ? AND status = 'draft'`).run(...params, itemId);
  return 'ok';
}
