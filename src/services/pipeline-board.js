/**
 * One board from first email to signed deal: every lead in the account by
 * stage (its status), each with the one thing worth knowing about it now — a
 * reply waiting, a meeting booked, where its sequence is, a reminder set.
 * Deal values come from the lead's open deal, when there is one.
 */
import db from '../db/index.js';
import { emailHash } from './unsubscribe.js';

export const BOARD_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won'];
const PER_COLUMN = 60;

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric' });

function byLead(rows, key = 'lead_id') {
  const m = new Map();
  for (const r of rows) if (!m.has(r[key])) m.set(r[key], r);
  return m;
}

export function boardFor(userId) {
  const leads = db.prepare(`
    SELECT id, name, company, title, score, status, source, email FROM leads
     WHERE user_id = ? ORDER BY score DESC, updated_at DESC LIMIT 2000
  `).all(userId);

  const suppressed = new Set(db.prepare('SELECT email_hash FROM email_suppressions WHERE user_id = ?').all(userId).map(r => r.email_hash));
  const replies = byLead(db.prepare("SELECT lead_id FROM replies WHERE user_id = ? AND status = 'new'").all(userId));
  const meetings = byLead(db.prepare(`
    SELECT lead_id, scheduled_at FROM appointments WHERE user_id = ? AND status IN ('scheduled', 'confirmed')
       AND type <> 'follow_up' AND scheduled_at >= ? ORDER BY scheduled_at
  `).all(userId, new Date().toISOString()));
  const reminders = byLead(db.prepare(`
    SELECT lead_id, scheduled_at FROM appointments WHERE user_id = ? AND status = 'scheduled'
       AND type = 'follow_up' AND scheduled_at >= ? ORDER BY scheduled_at
  `).all(userId, new Date().toISOString()));
  const seq = byLead(db.prepare(`
    SELECT oq.lead_id,
           SUM(oq.status = 'draft') AS drafts,
           SUM(oq.channel = 'linkedin' AND oq.status = 'pending' AND oq.scheduled_at <= datetime('now')) AS notes_due,
           MAX(CASE WHEN oq.channel = 'email' AND oq.status = 'sent' THEN oq.delay_days END) AS sent_day,
           MAX(CASE WHEN oq.channel = 'email' THEN oq.delay_days END) AS last_day,
           SUM(oq.channel = 'email' AND oq.status = 'pending') AS pending
      FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
     WHERE c.user_id = ? GROUP BY oq.lead_id
  `).all(userId));
  const deals = byLead(db.prepare(`
    SELECT id, lead_id, deal_value FROM pipeline WHERE user_id = ? AND stage NOT IN ('closed_lost') ORDER BY id DESC
  `).all(userId));

  const hint = (l) => {
    if (l.email && suppressed.has(emailHash(l.email))) return 'Opted out';
    if (replies.has(l.id)) return 'Reply waiting for you';
    if (meetings.has(l.id)) return `Meeting ${fmtWhen(meetings.get(l.id).scheduled_at)}`;
    const s = seq.get(l.id);
    if (s?.drafts) return 'Sequence waiting for approval';
    if (s?.notes_due) return 'LinkedIn note to send';
    if (s && s.sent_day !== null && s.pending) return `Day ${s.sent_day} of ${s.last_day}`;
    if (reminders.has(l.id)) return `Nurture · revisit ${fmtDay(reminders.get(l.id).scheduled_at)}`;
    if (s && s.sent_day !== null) return 'Sequence finished';
    if (l.source === 'referral') return 'Referral';
    return l.status === 'new' ? 'Not contacted yet' : '';
  };

  const columns = Object.fromEntries(BOARD_STAGES.map(s => [s, { count: 0, value: 0, cards: [] }]));
  let lost = 0;
  for (const l of leads) {
    if (l.status === 'lost') { lost++; continue; }
    const col = columns[l.status] || columns.new;
    const deal = deals.get(l.id);
    col.count++;
    col.value += deal?.deal_value || 0;
    if (col.cards.length < PER_COLUMN) {
      col.cards.push({
        lead_id: l.id, name: l.name, company: l.company || '', title: l.title || '', score: l.score || 0,
        hint: hint(l), deal_id: deal?.id || null, deal_value: deal?.deal_value || 0,
      });
    }
  }
  return { columns, lost };
}
