/**
 * The Monday brief, and the pipeline review asked for on the Pipeline page.
 *
 * The facts are counted here, from the account's own data: replies, drafts
 * and LinkedIn notes waiting for a person, the week's meetings and
 * reminders, the board by stage, where leads are stuck, and last week's
 * numbers. The assistant then writes a short reading of them
 * (pipeline_brief), using only those facts. If the AI allowance is used up
 * or the AI fails, the brief still goes out with the facts alone.
 *
 * Every Monday at 08:00 Malaysia time each active account with leads gets it
 * by email — once per week, however often the job runs.
 */
import db from '../db/index.js';
import { runAgent } from './ai-agent.js';
import { boardFor, BOARD_STAGES } from './pipeline-board.js';
import { getProfile } from './account-profile.js';
import { checkPlanLimitForUser, loadPlanUser } from '../middleware/auth.js';
import { sendEmail } from '../utils/email.js';

const DAY = 86400000;
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const when = (iso) => new Date(iso).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// The Monday (Malaysia time) of the week `now` falls in, as YYYY-MM-DD.
export function weekOf(now = new Date()) {
  const myt = new Date(now.getTime() + 8 * 3600 * 1000);
  const back = (myt.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate() - back)).toISOString().slice(0, 10);
}

export function briefFacts(userId, now = new Date()) {
  const nowIso = now.toISOString();
  const weekAhead = new Date(now.getTime() + 7 * DAY).toISOString();
  const weekAgo = sqlTime(new Date(now.getTime() - 7 * DAY));
  const fiveDaysAgo = sqlTime(new Date(now.getTime() - 5 * DAY));
  const count = (sql, ...p) => db.prepare(sql).get(...p).c;

  const repliesWaiting = db.prepare(`SELECT l.name FROM replies r JOIN leads l ON l.id = r.lead_id
                                      WHERE r.user_id = ? AND r.status = 'new' ORDER BY r.received_at DESC`).all(userId);
  const meetings = db.prepare(`SELECT l.name, l.company, a.scheduled_at FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id
                                WHERE a.user_id = ? AND a.type <> 'follow_up' AND a.status IN ('scheduled', 'confirmed')
                                  AND a.scheduled_at >= ? AND a.scheduled_at < ? ORDER BY a.scheduled_at LIMIT 15`).all(userId, nowIso, weekAhead);
  const reminders = db.prepare(`SELECT l.name, l.company, a.scheduled_at, a.notes FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id
                                 WHERE a.user_id = ? AND a.type = 'follow_up' AND a.status = 'scheduled'
                                   AND a.scheduled_at < ? ORDER BY a.scheduled_at LIMIT 15`).all(userId, weekAhead);
  const board = boardFor(userId);

  return {
    waiting_for_you: {
      replies: repliesWaiting.length,
      reply_from: repliesWaiting.slice(0, 5).map(r => r.name),
      drafts_to_approve: count(`SELECT COUNT(*) c FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id WHERE c.user_id = ? AND oq.status = 'draft'`, userId),
      linkedin_notes_to_send: count(`SELECT COUNT(*) c FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
                                      WHERE c.user_id = ? AND oq.channel = 'linkedin' AND oq.status = 'pending' AND oq.scheduled_at <= datetime('now')`, userId),
    },
    meetings_this_week: meetings.map(m => ({ name: m.name || 'Prospect', company: m.company || '', when: when(m.scheduled_at) })),
    reminders_due: reminders.map(r => ({ name: r.name || 'Prospect', company: r.company || '', when: when(r.scheduled_at), reason: String(r.notes || '').slice(0, 160) })),
    board: { ...Object.fromEntries(BOARD_STAGES.map(s => [s, board.columns[s].count])), lost: board.lost },
    open_deal_value_myr: Math.round(BOARD_STAGES.filter(s => s !== 'won').reduce((sum, s) => sum + board.columns[s].value, 0)),
    stuck: {
      opened_but_no_reply: count(`SELECT COUNT(DISTINCT cl.lead_id) c FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
                                   JOIN leads l ON l.id = cl.lead_id
                                  WHERE c.user_id = ? AND cl.status IN ('opened', 'clicked') AND l.status IN ('new', 'contacted')
                                    AND COALESCE(cl.opened_at, cl.sent_at) <= ?`, userId, fiveDaysAgo),
      clicked_voice_link_no_call: count(`SELECT COUNT(DISTINCT a.lead_id) c FROM activities a
                                          WHERE a.user_id = ? AND a.description LIKE 'Clicked link in campaign email:%call.html%'
                                            AND NOT EXISTS (SELECT 1 FROM activities v WHERE v.lead_id = a.lead_id AND v.type = 'voice_call')`, userId),
      qualified_without_meeting: count(`SELECT COUNT(*) c FROM leads l WHERE l.user_id = ? AND l.status = 'qualified'
                                         AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.type <> 'follow_up'
                                                           AND a.status IN ('scheduled', 'confirmed', 'completed'))`, userId),
    },
    last_7_days: {
      verified_leads: count(`SELECT COUNT(*) c FROM leads WHERE user_id = ? AND source IN ('ai_generated', 'apollo', 'referral') AND created_at >= ?`, userId, weekAgo),
      emails_sent: count(`SELECT COUNT(*) c FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
                           WHERE c.user_id = ? AND oq.channel = 'email' AND oq.status = 'sent' AND oq.sent_at >= ?`, userId, weekAgo),
      replies: count(`SELECT COUNT(*) c FROM replies WHERE user_id = ? AND received_at >= ? AND COALESCE(intent, '') <> 'out_of_office'`, userId, weekAgo),
      positive_replies: count(`SELECT COUNT(*) c FROM replies WHERE user_id = ? AND received_at >= ? AND intent IN ('interested', 'referral')`, userId, weekAgo),
      meetings_booked: count(`SELECT COUNT(*) c FROM appointments WHERE user_id = ? AND type IN ('meeting', 'demo', 'call') AND created_at >= ?`, userId, weekAgo),
    },
  };
}

/**
 * Count the facts, add the assistant's reading, keep it. kind 'weekly' is
 * once per week (an existing one is returned); 'review' is on request.
 */
export async function writeBrief(userId, { kind = 'review', now = new Date() } = {}) {
  const period = kind === 'weekly' ? weekOf(now) : now.toISOString();
  if (kind === 'weekly') {
    const existing = db.prepare("SELECT * FROM briefs WHERE user_id = ? AND kind = 'weekly' AND period = ?").get(userId, period);
    if (existing) return view(existing);
  }
  const facts = briefFacts(userId, now);
  let narrative = null;
  try {
    checkPlanLimitForUser(loadPlanUser(userId), 'ai_action');
    const r = await runAgent(userId, 'pipeline_brief', { facts });
    narrative = { headline: r.headline, stuck: r.stuck, focus: r.focus };
  } catch (e) {
    console.warn(`[brief] account ${userId}: facts only (${e.message})`);
  }
  const id = db.prepare('INSERT INTO briefs (user_id, kind, period, facts, narrative) VALUES (?, ?, ?, ?, ?)')
    .run(userId, kind, period, JSON.stringify(facts), narrative ? JSON.stringify(narrative) : null).lastInsertRowid;
  return view(db.prepare('SELECT * FROM briefs WHERE id = ?').get(id));
}

function view(row) {
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return { id: row.id, kind: row.kind, period: row.period, facts: parse(row.facts), narrative: parse(row.narrative), created_at: row.created_at, emailed_at: row.emailed_at };
}

export function latestBrief(userId) {
  const row = db.prepare("SELECT * FROM briefs WHERE user_id = ? AND kind IN ('weekly', 'review') ORDER BY created_at DESC, id DESC LIMIT 1").get(userId);
  return row ? view(row) : null;
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The facts as short lines, for the email and the app. */
export function factLines(f) {
  const lines = [];
  const w = f.waiting_for_you;
  if (w.replies) lines.push(`${w.replies} repl${w.replies === 1 ? 'y' : 'ies'} waiting for your answer${w.reply_from.length ? ` (${w.reply_from.join(', ')})` : ''}`);
  if (w.drafts_to_approve) lines.push(`${w.drafts_to_approve} draft${w.drafts_to_approve === 1 ? '' : 's'} waiting for approval`);
  if (w.linkedin_notes_to_send) lines.push(`${w.linkedin_notes_to_send} LinkedIn note${w.linkedin_notes_to_send === 1 ? '' : 's'} to send from your account`);
  for (const m of f.meetings_this_week) lines.push(`Meeting: ${m.name}${m.company ? ` (${m.company})` : ''}, ${m.when}`);
  for (const r of f.reminders_due) lines.push(`Reminder: revisit ${r.name}${r.company ? ` (${r.company})` : ''}, ${r.when}`);
  const s = f.stuck;
  if (s.opened_but_no_reply) lines.push(`${s.opened_but_no_reply} contacted lead${s.opened_but_no_reply === 1 ? '' : 's'} opened an email but have not replied`);
  if (s.clicked_voice_link_no_call) lines.push(`${s.clicked_voice_link_no_call} clicked the voice link without starting a call`);
  if (s.qualified_without_meeting) lines.push(`${s.qualified_without_meeting} qualified lead${s.qualified_without_meeting === 1 ? '' : 's'} with no meeting booked`);
  return lines;
}

export async function emailBrief(userId, brief) {
  const to = getProfile(userId).reply_to_email || db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email;
  if (!to) return false;
  const f = brief.facts;
  const n = brief.narrative;
  const l7 = f.last_7_days;
  const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value || 'https://sa.eiaawsolutions.com';
  await sendEmail({
    to,
    subject: `Your Monday brief — ${f.meetings_this_week.length} meeting${f.meetings_this_week.length === 1 ? '' : 's'}, ${f.waiting_for_you.replies} repl${f.waiting_for_you.replies === 1 ? 'y' : 'ies'} waiting`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;font-size:15px;line-height:1.6">
        <h2 style="font-size:18px;margin:0 0 10px">Monday brief</h2>
        ${n ? [n.headline, n.stuck, n.focus].filter(Boolean).map(p => `<p style="margin:0 0 10px">${esc(p)}</p>`).join('') : ''}
        ${factLines(f).length ? `<ul style="padding-left:18px;margin:10px 0">${factLines(f).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Nothing is waiting for you this week.</p>'}
        <p style="font-size:13px;color:#555;margin:14px 0 4px"><strong>Last 7 days:</strong> ${l7.verified_leads} verified leads · ${l7.emails_sent} emails sent · ${l7.replies} replies (${l7.positive_replies} positive) · ${l7.meetings_booked} meetings booked</p>
        <p style="font-size:13px;color:#555;margin:0"><strong>Board:</strong> ${['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won'].map(s => `${s} ${f.board[s]}`).join(' · ')}</p>
        <p style="margin-top:16px"><a href="${esc(baseUrl)}/app?p=pipeline" style="color:#1FA896">Open your pipeline</a></p>
      </div>`,
  });
  db.prepare('UPDATE briefs SET emailed_at = CURRENT_TIMESTAMP WHERE id = ?').run(brief.id);
  return true;
}

/** Monday 08:00 MYT: every active account that has leads gets its brief, once. */
export async function runMondayBriefs(now = new Date()) {
  const owners = db.prepare(`SELECT u.id FROM users u WHERE u.status = 'active' AND u.account_owner_id IS NULL
                              AND EXISTS (SELECT 1 FROM leads l WHERE l.user_id = u.id)`).all();
  let sent = 0;
  for (const { id } of owners) {
    try {
      const brief = await writeBrief(id, { kind: 'weekly', now });
      if (!brief.emailed_at && await emailBrief(id, brief)) sent++;
    } catch (e) { console.error(`[brief] account ${id}: ${e.message}`); }
  }
  return sent;
}
