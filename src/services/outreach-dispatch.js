/**
 * Sends approved outreach (outreach_queue rows in 'pending' whose time has
 * come). Called by the 30-minute scheduler and kicked right after an approval,
 * so a message can be due to two dispatchers at once. Each row is claimed
 * with a conditional UPDATE ('pending' → 'sending') before it is sent; only
 * the dispatcher whose UPDATE changed the row sends it.
 *
 * Drafts ('draft') are never touched here: nothing reaches a prospect until a
 * person approves it (see outreach-queue.js).
 *
 * A LinkedIn note in a sequence is the team's to send from their own account:
 * it is never sent here and never holds up the emails after it.
 *
 * One prospect never gets a sequence in a burst: a step is not claimed while
 * an earlier step to the same prospect is still waiting, and each send pushes
 * that prospect's later steps out to their own spacing from now. A paused
 * campaign that resumes, or a scheduler that was down, sends the next step
 * only — not Day 0, 3 and 7 within seconds.
 */
import db from '../db/index.js';
import { sendEmail } from '../utils/email.js';
import { injectTracking, appendFormCta } from './campaigns.js';
import { isSuppressed, prepareOutreachEmail } from './unsubscribe.js';
import { senderFor } from './account-profile.js';
import { replyAddressFor } from './reply-routing.js';

const BATCH = 20;
// A row stuck in 'sending' means the process died mid-send. Whether the email
// left is unknown, so it is marked failed for a person to look at rather than
// retried into a possible duplicate.
const STALE_SENDING_MINUTES = 15;

// Queue messages are plain text — written by the agent from web-sourced lead
// data, or typed into the approval editor. Email is HTML, where newlines
// collapse and a bare URL is not a link. So: escape everything (nothing the
// model wrote can render as markup or a disguised link in a prospect's inbox),
// keep line breaks, and turn https URLs into links, which also lets click
// tracking see the voice-call link.
export function toEmailHtml(message) {
  const escaped = String(message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linked = escaped.replace(/https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => `<a href="${url}">${url}</a>`);
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">${linked.replace(/\r?\n/g, '<br>')}</div>`;
}

function sendGapMs() {
  const n = Number(process.env.OUTREACH_SEND_GAP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

export async function processOutreachQueue({ campaignId = null } = {}) {
  try {
    db.prepare(`UPDATE outreach_queue SET status = 'failed'
                WHERE status = 'sending' AND claimed_at <= datetime('now', ?)`).run(`-${STALE_SENDING_MINUTES} minutes`);

    const due = db.prepare(`
      SELECT oq.*, l.email as lead_email, l.name as lead_name, c.name as campaign_name, c.user_id, c.form_id
      FROM outreach_queue oq
      JOIN leads l ON oq.lead_id = l.id
      JOIN campaigns c ON oq.campaign_id = c.id
      WHERE oq.status = 'pending'
        AND oq.channel IN ('email', 'ai_action')
        AND oq.scheduled_at <= datetime('now')
        AND c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM outreach_queue e
                         WHERE e.campaign_id = oq.campaign_id AND e.lead_id = oq.lead_id
                           AND e.step < oq.step AND e.status IN ('draft', 'pending', 'sending')
                           AND e.channel IN ('email', 'ai_action'))
        ${campaignId ? 'AND oq.campaign_id = ?' : ''}
      ORDER BY oq.scheduled_at ASC, oq.step ASC
      LIMIT ${BATCH}
    `).all(...(campaignId ? [campaignId] : []));

    if (due.length === 0) return 0;
    console.log(`[Scheduler] Processing ${due.length} pending outreach items`);

    const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value || 'https://sa.eiaawsolutions.com';
    const claim = db.prepare(`
      UPDATE outreach_queue SET status = 'sending', claimed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending' AND scheduled_at <= datetime('now')
         AND NOT EXISTS (SELECT 1 FROM outreach_queue e
                          WHERE e.campaign_id = outreach_queue.campaign_id AND e.lead_id = outreach_queue.lead_id
                            AND e.step < outreach_queue.step AND e.status IN ('draft', 'pending', 'sending')
                            AND e.channel IN ('email', 'ai_action'))`);
    const spaceLaterSteps = db.prepare(`
      UPDATE outreach_queue
         SET scheduled_at = datetime('now', '+' || MAX(COALESCE(delay_days, 0) - @delay, 1) || ' days')
       WHERE campaign_id = @campaignId AND lead_id = @leadId AND step > @step AND status = 'pending'
         AND scheduled_at < datetime('now', '+' || MAX(COALESCE(delay_days, 0) - @delay, 1) || ' days')`);
    let sentCount = 0;

    for (const item of due) {
      if (claim.run(item.id).changes === 0) continue; // another dispatcher has it, or it is not this prospect's turn

      try {
        if (!item.lead_email) {
          db.prepare("UPDATE outreach_queue SET status = 'failed' WHERE id = ?").run(item.id);
          continue;
        }

        // Opted out of this account's email: skip, never send.
        if (isSuppressed(item.user_id, item.lead_email)) {
          db.prepare("UPDATE outreach_queue SET status = 'skipped' WHERE id = ?").run(item.id);
          continue;
        }

        // The campaign email already reached this prospect: the Day-0 outreach
        // would be a second first-touch the same day. Follow-ups still go.
        if (item.step === 1) {
          const reached = db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?').get(item.campaign_id, item.lead_id);
          if (reached && ['sent', 'opened', 'clicked'].includes(reached.status)) {
            db.prepare("UPDATE outreach_queue SET status = 'skipped' WHERE id = ?").run(item.id);
            continue;
          }
        }

        // Unsubscribe link + one-click headers, then tracking
        const emailBody = toEmailHtml(item.message);
        const withForm = appendFormCta(emailBody, item.form_id, item.campaign_id, item.lead_id, baseUrl);
        const { html: withUnsub, headers } = prepareOutreachEmail({ html: withForm, baseUrl, campaignId: item.campaign_id, leadId: item.lead_id });
        const trackedHtml = injectTracking(withUnsub, item.campaign_id, item.lead_id, baseUrl);

        const sent = await sendEmail({
          to: item.lead_email,
          subject: item.subject || `Following up: ${item.campaign_name}`,
          html: trackedHtml,
          headers,
          ...senderFor(item.user_id),
          // Replies come back to the agent (and are forwarded to the account's inbox).
          ...(replyAddressFor(item.lead_id) ? { replyTo: replyAddressFor(item.lead_id) } : {}),
        });

        db.prepare("UPDATE outreach_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP, provider_message_id = ? WHERE id = ?")
          .run(sent?.id || null, item.id);
        spaceLaterSteps.run({ campaignId: item.campaign_id, leadId: item.lead_id, step: item.step, delay: item.delay_days || 0 });
        db.prepare("UPDATE campaign_leads SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'")
          .run(item.campaign_id, item.lead_id);
        db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?')
          .run(item.campaign_id);
        db.prepare('INSERT INTO activities (lead_id, campaign_id, type, description, user_id) VALUES (?, ?, ?, ?, ?)')
          .run(item.lead_id, item.campaign_id, 'email',
            `Auto-outreach Step ${item.step}: ${item.subject || 'Follow-up'}`,
            item.user_id || 1);
        sentCount++;

        console.log(`[Scheduler] Sent Step ${item.step} to lead ${item.lead_id}`);

        // Small delay between sends to respect rate limits
        const gap = sendGapMs();
        if (gap) await new Promise(r => setTimeout(r, gap));
      } catch (err) {
        db.prepare("UPDATE outreach_queue SET status = 'failed' WHERE id = ?").run(item.id);
        console.error(`[Scheduler] Failed to send to lead ${item.lead_id}:`, err.message);
      }
    }
    return sentCount;
  } catch (err) {
    console.error('[Scheduler] Outreach queue error:', err.message);
    return 0;
  }
}

// Fire-and-forget dispatch, used right after an approval so Day-0 messages
// do not wait up to 30 minutes for the next scheduler tick.
export function kickDispatch(campaignId) {
  setImmediate(() => { processOutreachQueue({ campaignId }).catch(() => {}); });
}
