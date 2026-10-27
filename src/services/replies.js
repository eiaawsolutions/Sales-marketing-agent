/**
 * What happens when a prospect replies.
 *
 * Replies arrive two ways: read automatically from the reply address
 * (inbound-replies.js, when INBOUND_REPLY_DOMAIN is set) or pasted in by a
 * person. Either way a reply stops every sequence to that person across the
 * account, the AI labels its intent, the label's fixed action is taken, and
 * a drafted answer waits for a person to approve and send. Each reply is kept
 * in `replies` with what the agent did, for the Replies inbox.
 *
 * The label is the only thing the reply text can influence (see
 * classifyReplyTask), so a reply cannot make the app do anything else.
 */
import db from '../db/index.js';
import { runAgent, buildNotes } from './ai-agent.js';
import { suppress, isSuppressed } from './unsubscribe.js';
import { sendEmail } from '../utils/email.js';
import { senderFor, getProfile } from './account-profile.js';
import { toEmailHtml } from './outreach-dispatch.js';
import { replyAddressFor } from './reply-routing.js';
import { hasCalendar, offerTimes } from './calendar.js';
import { leadSourcesService } from './lead-sources.js';
import { checkPlanLimitForUser, loadPlanUser } from '../middleware/auth.js';
import { normalizePhone } from '../utils/normalize.js';

const mytStamp = () => new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });
const mytDate = (ymd) => new Date(`${ymd}T09:00:00+08:00`).toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'long', year: 'numeric' });

/** Cancel everything not yet sent to this lead in any of the account's campaigns. */
export function stopSequences(userId, leadId) {
  const stopped = db.prepare(`
    UPDATE outreach_queue SET status = 'skipped'
     WHERE lead_id = ? AND status IN ('draft', 'pending')
       AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)
  `).run(leadId, userId).changes;
  db.prepare(`
    UPDATE campaign_leads SET status = 'replied'
     WHERE lead_id = ? AND status <> 'bounced'
       AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)
  `).run(leadId, userId);
  return stopped;
}

// An interested reply puts the lead's deal at Qualified: a new deal if there
// is none open, or an open one moved up from prospecting.
function qualifyDeal(userId, leadId) {
  const open = db.prepare("SELECT id, stage FROM pipeline WHERE lead_id = ? AND user_id = ? AND stage NOT IN ('closed_won', 'closed_lost') ORDER BY id DESC LIMIT 1").get(leadId, userId);
  if (!open) {
    db.prepare("INSERT INTO pipeline (user_id, lead_id, stage, deal_value, probability, notes) VALUES (?, ?, 'qualification', 0, 30, 'Opened when they replied with interest')").run(userId, leadId);
    return true;
  }
  if (open.stage === 'prospecting') {
    db.prepare("UPDATE pipeline SET stage = 'qualification', probability = MAX(probability, 30), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(open.id);
    return true;
  }
  return false;
}

// "Try me in April": a follow-up reminder on that date (default 90 days),
// shown under Appointments and in the Monday brief. Nothing is sent to the
// prospect.
function setReminder(userId, lead, ymd, reason) {
  const day = ymd || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, status, type, notes)
              VALUES (?, ?, ?, ?, 15, 'scheduled', 'follow_up', ?)`)
    .run(lead.id, userId, `Revisit ${lead.name}${lead.company ? ` (${lead.company})` : ''}`, new Date(`${day}T09:00:00+08:00`).toISOString(), String(reason || '').slice(0, 500));
  return day;
}

// The lead the referral names, verified on the open web, in the same campaign
// as the person who referred them, with a first email drafted for approval.
async function followReferral(userId, referrer, referral, actions) {
  const giveUp = (why) => {
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'task', ?)")
      .run(userId, referrer.id, `Referred to ${referral.name}${referral.role ? ` (${referral.role})` : ''} — ${why}; find and verify them before reaching out`);
    actions.push(`Could not verify ${referral.name} from public sources (${why}) — added a task to find them. Nobody is contacted until they are verified.`);
    return null;
  };
  try {
    const owner = loadPlanUser(userId);
    checkPlanLimitForUser(owner, 'auto_leads');
    checkPlanLimitForUser(owner, 'ai_action');
  } catch { return giveUp('lead search is not included on this plan or the AI allowance is used up'); }

  let found;
  try { found = await runAgent(userId, 'verify_referral', { leadId: referrer.id, name: referral.name, role: referral.role }); } catch (e) { return giveUp(e.message); }
  if (!found?.verified) return giveUp(found?.reason || 'not found');

  const c = found.candidate;
  const email = String(c.email).trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM leads WHERE user_id = ? AND email_normalized = ?').get(userId, email);
  let leadId = existing?.id;
  if (!leadId) {
    const sourceId = leadSourcesService.internalSourceId(userId, 'ai_websearch');
    const notes = [`Referral: ${referrer.name}${referrer.title ? ` (${referrer.title})` : ''} at ${referrer.company || 'their company'} suggested getting in touch, ${mytStamp()}`, buildNotes(c)].join('\n');
    leadId = db.prepare(`
      INSERT INTO leads (user_id, name, email, company, title, phone, source, notes, email_normalized, phone_normalized, source_id, first_source_id, last_source_id)
      VALUES (?, ?, ?, ?, ?, ?, 'referral', ?, ?, ?, ?, ?, ?)
    `).run(userId, c.name, email, c.company || referrer.company, c.title || referral.role || '', c.phone || '', notes,
      email, normalizePhone(c.phone), sourceId, sourceId, sourceId).lastInsertRowid;
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'ai_action', ?)")
      .run(userId, leadId, `Referred by ${referrer.name}; verified on public sources`);
  }
  actions.push(`Found ${c.name}'s public profile and verified their role${c.title ? ` (${c.title})` : ''}`);
  actions.push(existing ? `${c.name} was already in your leads — noted the referral from ${referrer.name}` : `Created a new lead and noted the referral from ${referrer.name}`);
  if (existing) {
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'note', ?)").run(userId, leadId, `Referred by ${referrer.name}`);
  }

  const campaign = db.prepare(`
    SELECT cl.campaign_id FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
     WHERE cl.lead_id = ? AND c.user_id = ? AND c.status NOT IN ('stopped', 'completed') ORDER BY cl.rowid DESC LIMIT 1
  `).get(referrer.id, userId);
  if (campaign && !db.prepare('SELECT 1 FROM outreach_queue WHERE campaign_id = ? AND lead_id = ?').get(campaign.campaign_id, leadId)) {
    db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)').run(campaign.campaign_id, leadId);
    try {
      checkPlanLimitForUser(loadPlanUser(userId), 'auto_outreach');
      await runAgent(userId, 'auto_outreach', { campaignId: campaign.campaign_id, leadIds: [leadId], forceDraft: true });
      actions.push(`Drafted a first email that mentions ${referrer.name}'s referral, waiting for your approval`);
    } catch (e) {
      actions.push(`Added ${c.name} to the campaign; the first email could not be drafted (${e.message})`);
    }
  }
  return leadId;
}

/**
 * Label a reply and act on it. `replyId` is an inbound reply row already
 * stored; without it the reply was pasted and a row is created. `stopped` is
 * how many messages the caller already cancelled (inbound replies stop the
 * sequence before the AI runs).
 */
export async function handleReply({ userId, lead, text, replyId = null, stopped = null }) {
  const offers = hasCalendar(userId) ? (await offerTimes(userId, { count: 3 })).map(o => o.label) : [];
  const result = await runAgent(userId, 'classify_reply', { leadId: lead.id, text, offerTimes: offers });
  const { intent } = result;
  const actions = [];
  const host = getProfile(userId).sender_name || 'you';

  // An auto-reply is not a reply: the sequence carries on.
  let cancelled = 0;
  if (intent === 'out_of_office') {
    actions.push('Auto-reply: the sequence carries on');
  } else {
    cancelled = (stopped ?? 0) + stopSequences(userId, lead.id);
    actions.push(cancelled > 0
      ? `Stopped the sequence for ${lead.name} (${cancelled} message${cancelled === 1 ? '' : 's'} cancelled)`
      : `Nothing more was scheduled to ${lead.name}`);
  }

  if (intent === 'opt_out') {
    if (lead.email) suppress({ userId, email: lead.email, reason: 'unsubscribe', leadId: lead.id });
    actions.push('Unsubscribed and added to the do-not-email list across every campaign');
    actions.push(`Logged the request on ${mytStamp()} (PDPA)`);
    actions.push('No reply sent');
  } else if (intent === 'interested') {
    db.prepare("UPDATE leads SET status = 'qualified', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status IN ('new', 'contacted')").run(lead.id, userId);
    if (qualifyDeal(userId, lead.id)) actions.push('Moved the deal to Qualified');
    if (offers.length) actions.push(`Checked ${host}'s calendar`);
    actions.push(offers.length ? `Drafted a reply offering ${offers.length} free time${offers.length === 1 ? '' : 's'}, waiting for your approval` : 'Drafted a reply, waiting for your approval');
  } else if (intent === 'not_interested') {
    db.prepare("UPDATE leads SET status = 'lost', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status IN ('new', 'contacted', 'qualified')").run(lead.id, userId);
    actions.push('Marked as not interested');
  } else if (intent === 'not_now') {
    db.prepare("UPDATE leads SET status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'new'").run(lead.id, userId);
    const day = setReminder(userId, lead, result.revisit_on, result.summary);
    actions.push(`Set a reminder for ${mytDate(day)}`);
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'note', ?)")
      .run(userId, lead.id, `Nurture — not now. ${result.summary || ''} Revisit ${mytDate(day)}.`.slice(0, 500));
    actions.push('Kept the lead to nurture, with their reason noted');
  } else if (intent === 'question') {
    db.prepare("UPDATE leads SET status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'new'").run(lead.id, userId);
    if (result.suggested_reply) actions.push('Drafted an answer from your brief, waiting for your approval');
  } else if (intent === 'referral' && result.suggested_reply) {
    actions.push('Drafted a thank-you reply, waiting for your approval');
  }

  db.prepare("INSERT INTO activities (user_id, lead_id, type, description, outcome) VALUES (?, ?, 'email', ?, ?)")
    .run(userId, lead.id, `Reply received — ${intent.replace(/_/g, ' ')}: ${result.summary || ''}`.slice(0, 500),
      JSON.stringify({ intent, confidence: result.confidence, excerpt: String(text).slice(0, 1000) }));

  // A referred contact becomes a lead only once verified (lead contract).
  if (intent === 'referral' && result.referral?.name) await followReferral(userId, lead, result.referral, actions);

  const fields = {
    intent, confidence: result.confidence, summary: result.summary || '', next_step: result.next_step || '',
    actions: JSON.stringify(actions),
    suggested_subject: result.suggested_reply?.subject || null, suggested_body: result.suggested_reply?.body || null,
    status: intent === 'out_of_office' || intent === 'opt_out' ? 'dismissed' : 'new',
  };
  if (replyId) {
    db.prepare(`UPDATE replies SET intent = @intent, confidence = @confidence, summary = @summary, next_step = @next_step,
                  actions = @actions, suggested_subject = @suggested_subject, suggested_body = @suggested_body,
                  status = @status, error = NULL, handled_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ ...fields, id: replyId });
  } else {
    replyId = db.prepare(`INSERT INTO replies (user_id, lead_id, source, body, intent, confidence, summary, next_step, actions,
                            suggested_subject, suggested_body, status, handled_at)
                          VALUES (@user_id, @lead_id, 'pasted', @body, @intent, @confidence, @summary, @next_step, @actions,
                            @suggested_subject, @suggested_body, @status, CURRENT_TIMESTAMP)`)
      .run({ ...fields, user_id: userId, lead_id: lead.id, body: String(text).slice(0, 10000) }).lastInsertRowid;
  }

  return { ...result, reply_id: Number(replyId), actions, sequences_stopped: cancelled };
}

/** Send a reply the user has read and approved, as the account. */
export async function sendReply({ userId, lead, subject, body, inReplyTo = null }) {
  if (!lead.email) return { error: 'This lead has no email address.', status: 400 };
  if (isSuppressed(userId, lead.email)) return { error: 'This person asked not to be emailed.', status: 409 };
  const routed = replyAddressFor(lead.id);
  const sent = await sendEmail({
    to: lead.email,
    subject: String(subject || '').trim().slice(0, 200) || 'Re:',
    html: toEmailHtml(body),
    ...senderFor(userId),
    ...(routed ? { replyTo: routed } : {}),
    ...(inReplyTo ? { headers: { 'In-Reply-To': inReplyTo, References: inReplyTo } } : {}),
  });
  db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'email', ?)")
    .run(userId, lead.id, `Reply sent: ${String(subject || '').slice(0, 120)}`);
  return { ok: true, id: sent?.id || null };
}

// ── The Replies inbox ─────────────────────────────────────────────────────
function rowView(r) {
  let actions = [];
  try { actions = r.actions ? JSON.parse(r.actions) : []; } catch { actions = []; }
  return {
    id: r.id, lead_id: r.lead_id, lead_name: r.lead_name, lead_company: r.lead_company, source: r.source,
    subject: r.subject, body: r.body, intent: r.intent, confidence: r.confidence, summary: r.summary,
    next_step: r.next_step, actions, suggested_subject: r.suggested_subject, suggested_body: r.suggested_body,
    status: r.status, received_at: r.received_at, handled_at: r.handled_at,
  };
}

export function listReplies(userId, { open = false } = {}) {
  return db.prepare(`
    SELECT r.*, l.name AS lead_name, l.company AS lead_company FROM replies r JOIN leads l ON l.id = r.lead_id
     WHERE r.user_id = ? AND r.status IN (${open ? "'new'" : "'new', 'answered', 'dismissed', 'failed', 'processing', 'received'"})
     ORDER BY r.received_at DESC, r.id DESC LIMIT 200
  `).all(userId).map(rowView);
}

export function openReplyCount(userId) {
  return db.prepare("SELECT COUNT(*) AS c FROM replies WHERE user_id = ? AND status = 'new'").get(userId).c;
}

export function getReply(userId, id) {
  const r = db.prepare('SELECT r.*, l.name AS lead_name, l.company AS lead_company FROM replies r JOIN leads l ON l.id = r.lead_id WHERE r.id = ? AND r.user_id = ?').get(id, userId);
  return r ? { ...rowView(r), message_id: r.message_id } : null;
}

export async function answerReply(userId, id, { subject, body }) {
  const reply = getReply(userId, id);
  if (!reply) return { error: 'Reply not found', status: 404 };
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(reply.lead_id, userId);
  const r = await sendReply({ userId, lead, subject, body, inReplyTo: reply.message_id || null });
  if (r.error) return r;
  db.prepare("UPDATE replies SET status = 'answered', handled_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return r;
}

export function dismissReply(userId, id) {
  return db.prepare("UPDATE replies SET status = 'dismissed', handled_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
