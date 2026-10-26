/**
 * What happens when a prospect replies.
 *
 * Replies land in the account's own inbox (outreach is sent with the
 * account's reply-to), so the user logs them here — paste the text. A reply
 * stops every sequence to that person across the account, the AI labels its
 * intent, and a drafted answer waits for the user to approve and send.
 *
 * Each label maps to a fixed action below. The label is the only thing the
 * reply text can influence (see classifyReplyTask), so a reply cannot make the
 * app do anything else.
 */
import db from '../db/index.js';
import { runAgent } from './ai-agent.js';
import { suppress, isSuppressed } from './unsubscribe.js';
import { sendEmail } from '../utils/email.js';
import { senderFor } from './account-profile.js';
import { toEmailHtml } from './outreach-dispatch.js';

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

export async function handleReply({ userId, lead, text }) {
  const result = await runAgent(userId, 'classify_reply', { leadId: lead.id, text });
  const { intent } = result;

  // An auto-reply is not a reply: the sequence carries on.
  const stopped = intent === 'out_of_office' ? 0 : stopSequences(userId, lead.id);

  if (intent === 'opt_out' && lead.email) {
    suppress({ userId, email: lead.email, reason: 'unsubscribe', leadId: lead.id });
  } else if (intent === 'interested') {
    db.prepare("UPDATE leads SET status = 'qualified', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status IN ('new', 'contacted')").run(lead.id, userId);
  } else if (intent === 'not_interested') {
    db.prepare("UPDATE leads SET status = 'lost', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status IN ('new', 'contacted', 'qualified')").run(lead.id, userId);
  } else if (intent === 'not_now' || intent === 'question') {
    db.prepare("UPDATE leads SET status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'new'").run(lead.id, userId);
  }

  db.prepare("INSERT INTO activities (user_id, lead_id, type, description, outcome) VALUES (?, ?, 'email', ?, ?)")
    .run(userId, lead.id, `Reply received — ${intent.replace(/_/g, ' ')}: ${result.summary || ''}`.slice(0, 500),
      JSON.stringify({ intent, confidence: result.confidence, excerpt: String(text).slice(0, 1000) }));

  // A referred contact is a lead to find and verify, not one to invent: the
  // lead contract forbids guessing their email.
  if (result.referral?.name) {
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'task', ?)")
      .run(userId, lead.id, `Referred to ${result.referral.name}${result.referral.role ? ` (${result.referral.role})` : ''} — find and verify them before reaching out`);
  }

  return { ...result, sequences_stopped: stopped };
}

/** Send a reply the user has read and approved, as the account. */
export async function sendReply({ userId, lead, subject, body }) {
  if (!lead.email) return { error: 'This lead has no email address.', status: 400 };
  if (isSuppressed(userId, lead.email)) return { error: 'This person asked not to be emailed.', status: 409 };
  const sent = await sendEmail({
    to: lead.email,
    subject: String(subject || '').trim().slice(0, 200) || 'Re:',
    html: toEmailHtml(body),
    ...senderFor(userId),
  });
  db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'email', ?)")
    .run(userId, lead.id, `Reply sent: ${String(subject || '').slice(0, 120)}`);
  return { ok: true, id: sent?.id || null };
}
