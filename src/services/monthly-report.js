/**
 * The monthly report: verified leads, prospects emailed, reply rate,
 * positive replies, meetings booked and cost per meeting — the numbers the
 * pilot is judged on, counted from what the app actually did that month
 * (Malaysia time). It is shown on the Reports page and emailed to the account
 * owner on the 1st for the month before.
 *
 * Replies count only when the app saw them: read automatically from the
 * reply address, or pasted in. Automatic away messages are not replies.
 */
import db from '../db/index.js';
import { PLAN_PRICES_MYR, loadPlanUser } from '../middleware/auth.js';
import { getProfile } from './account-profile.js';
import { sendEmail } from '../utils/email.js';

const MYT_MS = 8 * 3600 * 1000;
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

export function currentMonth(now = new Date()) {
  return new Date(now.getTime() + MYT_MS).toISOString().slice(0, 7);
}

export function previousMonth(now = new Date()) {
  const myt = new Date(now.getTime() + MYT_MS);
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

export function isMonth(v) {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1) - MYT_MS), to: new Date(Date.UTC(y, m, 1) - MYT_MS) };
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function monthlyReport(userId, month) {
  const { from, to } = monthRange(month);
  const range = [sqlTime(from), sqlTime(to)];
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;

  const verified = count(`SELECT COUNT(*) c FROM leads WHERE user_id = ? AND source IN ('ai_generated', 'apollo', 'referral')
                            AND created_at >= ? AND created_at < ?`, userId, ...range);
  // Outreach emails the dispatcher sent, plus one-off campaign sends.
  const emailed = db.prepare(`
    SELECT oq.lead_id FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
     WHERE c.user_id = ? AND oq.channel = 'email' AND oq.status = 'sent' AND oq.sent_at >= ? AND oq.sent_at < ?
    UNION ALL
    SELECT lead_id FROM activities WHERE user_id = ? AND type = 'email' AND description LIKE 'Sent campaign:%' AND created_at >= ? AND created_at < ?
  `).all(userId, ...range, userId, ...range);
  const replies = count(`SELECT COUNT(*) c FROM replies WHERE user_id = ? AND received_at >= ? AND received_at < ?
                           AND COALESCE(intent, '') <> 'out_of_office'`, userId, ...range);
  const positive = count(`SELECT COUNT(*) c FROM replies WHERE user_id = ? AND received_at >= ? AND received_at < ?
                            AND intent IN ('interested', 'referral')`, userId, ...range);
  const meetings = count(`SELECT COUNT(*) c FROM appointments WHERE user_id = ? AND type IN ('meeting', 'demo', 'call')
                            AND status <> 'cancelled' AND created_at >= ? AND created_at < ?`, userId, ...range);

  let plan = 'starter';
  try { plan = loadPlanUser(userId).plan; } catch { /* deleted account */ }
  const price = PLAN_PRICES_MYR[plan] ?? null;
  const prospects = new Set(emailed.map(r => r.lead_id)).size;

  return {
    month, label: monthLabel(month),
    verified_leads: verified,
    prospects_emailed: prospects,
    emails_sent: emailed.length,
    replies,
    reply_rate: pct(replies, prospects),
    positive_replies: positive,
    positive_rate: pct(positive, prospects),
    meetings_booked: meetings,
    plan, plan_price_myr: price,
    cost_per_meeting_myr: price !== null && meetings > 0 ? Math.round(price / meetings) : null,
  };
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function reportRows(r) {
  return [
    ['Verified leads added', r.verified_leads],
    ['Prospects emailed', r.prospects_emailed],
    ['Replies', r.replies],
    ['Reply rate', r.reply_rate === null ? '—' : `${r.reply_rate}%`],
    ['Positive replies', `${r.positive_replies}${r.positive_rate === null ? '' : ` (${r.positive_rate}%)`}`],
    ['Meetings booked', r.meetings_booked],
    ['Cost per meeting', r.cost_per_meeting_myr === null ? '—' : `RM ${r.cost_per_meeting_myr.toLocaleString('en-MY')}`],
  ];
}

/** Email one month's report to the account owner, once per month. */
export async function emailMonthlyReport(userId, month) {
  const r = monthlyReport(userId, month);
  const existing = db.prepare("SELECT id, emailed_at FROM briefs WHERE user_id = ? AND kind = 'monthly' AND period = ?").get(userId, month);
  if (existing?.emailed_at) return { sent: false, report: r };
  const to = getProfile(userId).reply_to_email || db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email;
  if (!to) return { sent: false, report: r };
  const id = existing?.id || db.prepare("INSERT INTO briefs (user_id, kind, period, facts) VALUES (?, 'monthly', ?, ?)").run(userId, month, JSON.stringify(r)).lastInsertRowid;
  await sendEmail({
    to,
    subject: `Your SalesAgent report — ${r.label}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#1a1a1a">
        <h2 style="font-size:18px;margin:0 0 4px">${esc(r.label)}</h2>
        <p style="font-size:13px;color:#666;margin:0 0 14px">What the agent did this month, counted from your account.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${reportRows(r).map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600">${esc(v)}</td></tr>`).join('')}
        </table>
        <p style="font-size:12px;color:#888;margin-top:14px">Reply rate is replies over prospects emailed. Cost per meeting is your plan price${r.plan_price_myr ? ` (RM ${r.plan_price_myr})` : ''} over meetings booked. Replies count when the agent saw them — read automatically or pasted in.</p>
      </div>`,
  });
  db.prepare('UPDATE briefs SET facts = ?, emailed_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(r), id);
  return { sent: true, report: r };
}

/** The 1st of the month: last month's report to every account that did anything. */
export async function runMonthlyReports(now = new Date()) {
  const month = previousMonth(now);
  const owners = db.prepare("SELECT id FROM users WHERE status = 'active' AND account_owner_id IS NULL").all();
  let sent = 0;
  for (const { id } of owners) {
    const r = monthlyReport(id, month);
    if (!r.verified_leads && !r.emails_sent && !r.replies && !r.meetings_booked) continue;
    try { if ((await emailMonthlyReport(id, month)).sent) sent++; } catch (e) { console.error(`[report] account ${id}: ${e.message}`); }
  }
  return sent;
}
