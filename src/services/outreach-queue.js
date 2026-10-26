/**
 * The approval step between the agent drafting outreach and anything being
 * sent. Drafts ('draft') are approved into the send queue ('pending'), edited
 * while still drafts, or skipped. Callers have already checked that the
 * campaign belongs to the user (routes/campaigns.js router.param).
 */
import db from '../db/index.js';
import { kickDispatch } from './outreach-dispatch.js';

const MAX_SUBJECT = 200;
const MAX_MESSAGE = 20000;

function idList(values) {
  return Array.isArray(values) ? [...new Set(values.map(Number).filter(Number.isInteger))] : [];
}

/**
 * Approve a campaign's drafts — all of them, or only some leads / items.
 * Each step is re-scheduled from the moment of approval (Day 0 now, Day 3 in
 * three days), so a draft that waited a week does not fire every step at once.
 */
export function approveDrafts({ campaignId, leadIds, itemIds, approvedBy }) {
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
