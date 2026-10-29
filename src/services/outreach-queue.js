/**
 * The approval step between the agent drafting outreach and anything being
 * sent. Drafts ('draft') are approved into the send queue ('pending'), edited
 * while still drafts, or skipped. Callers have already checked that the
 * campaign belongs to the user (routes/campaigns.js router.param).
 */
import db from '../db/index.js';
import { kickDispatch } from './outreach-dispatch.js';
import { runAgent } from './ai-agent.js';
import { LINKEDIN_NOTE_MAX } from '../utils/linkedin-note.js';

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

/** One queue item in one campaign, or null. */
export function getQueueItem(campaignId, itemId) {
  return db.prepare('SELECT * FROM outreach_queue WHERE id = ? AND campaign_id = ?').get(itemId, campaignId) || null;
}

/**
 * The team sent a LinkedIn note from their own account. Marks it sent (and
 * approved, if it was still a draft) and logs it on the lead. Returns 'ok',
 * 'not_found', 'not_linkedin' or 'closed' (already sent or skipped).
 */
export function markLinkedinSent({ campaignId, itemId, by }) {
  const item = getQueueItem(campaignId, itemId);
  if (!item) return 'not_found';
  if (item.channel !== 'linkedin') return 'not_linkedin';
  const { changes } = db.prepare(`
    UPDATE outreach_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP,
           approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), approved_by = COALESCE(approved_by, ?)
     WHERE id = ? AND status IN ('draft', 'pending')
  `).run(by, itemId);
  if (!changes) return 'closed';
  db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?, ?, ?, 'note', ?)")
    .run(item.user_id, item.lead_id, campaignId, NOTE_SENT);
  markContacted(item.lead_id);
  return 'ok';
}

const NOTE_SENT = 'LinkedIn connection note sent from your own account';

// A lead someone has written to is Contacted. Only from New: a lead already
// further along keeps its stage.
function markContacted(leadId) {
  db.prepare("UPDATE leads SET status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'new'").run(leadId);
}

/**
 * The team sent a note from the outreach window (not the approval queue) from
 * their own LinkedIn account. Logs it on the lead with its text and marks the
 * lead Contacted. LinkedIn takes one invitation per person, so a note already
 * logged for this lead is reported instead of logged twice, and any note still
 * waiting in the account's campaigns is closed: the first records this text as
 * sent, any others are skipped. The caller has checked that the lead is theirs.
 */
export function recordLinkedinNoteSent({ userId, leadId, message, by }) {
  const text = String(message || '').trim().slice(0, LINKEDIN_NOTE_MAX);
  return db.transaction(() => {
    const prior = db.prepare("SELECT created_at FROM activities WHERE lead_id = ? AND type = 'note' AND description LIKE ? ORDER BY id DESC LIMIT 1")
      .get(leadId, `${NOTE_SENT}%`);
    if (prior) return { ok: true, already: true, sent_at: prior.created_at };
    const [first, ...rest] = db.prepare(`
      SELECT oq.id, oq.campaign_id FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
       WHERE c.user_id = ? AND oq.lead_id = ? AND oq.channel = 'linkedin' AND oq.status IN ('draft', 'pending')
       ORDER BY oq.id
    `).all(userId, leadId);
    if (first) {
      db.prepare(`
        UPDATE outreach_queue SET status = 'sent', message = ?, highlights = NULL, sent_at = CURRENT_TIMESTAMP,
               approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), approved_by = COALESCE(approved_by, ?)
         WHERE id = ?
      `).run(text, by, first.id);
    }
    for (const r of rest) db.prepare("UPDATE outreach_queue SET status = 'skipped' WHERE id = ?").run(r.id);
    db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?, ?, ?, 'note', ?)")
      .run(userId, leadId, first?.campaign_id ?? null, `${NOTE_SENT}: "${text}"`);
    markContacted(leadId);
    return { ok: true, already: false, queue_note_closed: Boolean(first) };
  })();
}

/**
 * Edit a draft's subject and/or body. Returns 'ok', 'not_found', 'not_draft' or
 * 'too_long' (a LinkedIn note over LinkedIn's limit).
 */
export function editDraft({ campaignId, itemId, subject, message }) {
  const row = db.prepare('SELECT status, channel FROM outreach_queue WHERE id = ? AND campaign_id = ?').get(itemId, campaignId);
  if (!row) return 'not_found';
  if (row.status !== 'draft') return 'not_draft';
  if (row.channel === 'linkedin' && typeof message === 'string' && message.trim().length > LINKEDIN_NOTE_MAX) return 'too_long';
  const fields = [];
  const params = [];
  if (typeof subject === 'string') { fields.push('subject = ?'); params.push(subject.trim().slice(0, MAX_SUBJECT)); }
  if (typeof message === 'string' && message.trim()) { fields.push('message = ?'); params.push(message.slice(0, MAX_MESSAGE)); }
  if (!fields.length) return 'ok';
  db.prepare(`UPDATE outreach_queue SET ${fields.join(', ')} WHERE id = ? AND status = 'draft'`).run(...params, itemId);
  return 'ok';
}
