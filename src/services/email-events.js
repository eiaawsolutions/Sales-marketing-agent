/**
 * Resend delivery events for outreach email (POST /api/tracking/webhook; the
 * route verifies the Svix signature before anything here runs).
 *
 * Each event is matched to one outreach send by Resend's email id, stored on
 * campaign_leads / outreach_queue when the email went out. Everything else
 * Resend reports matches nothing and is ignored: sign-up and billing mail,
 * other EIAAW apps on the same Resend account, and sends from before ids were
 * stored. Matching on the recipient address instead would move another
 * account's stats whenever two accounts email the same person.
 *
 * Handlers are idempotent because Svix retries a delivery until it gets a 2xx.
 */
import db from '../db/index.js';
import { suppress } from './unsubscribe.js';

function findSend(emailId) {
  if (!emailId) return null;
  return db.prepare(`
    SELECT s.campaign_id, s.lead_id, c.user_id, l.email AS lead_email
    FROM (SELECT campaign_id, lead_id FROM campaign_leads WHERE provider_message_id = @id
          UNION ALL
          SELECT campaign_id, lead_id FROM outreach_queue WHERE provider_message_id = @id) s
    JOIN campaigns c ON c.id = s.campaign_id
    LEFT JOIN leads l ON l.id = s.lead_id AND l.user_id = c.user_id
    LIMIT 1
  `).get({ id: String(emailId) });
}

/** Apply one verified Resend event. Returns what was done, for logs and tests. */
export function recordEmailEvent(event) {
  const send = findSend(event?.data?.email_id);
  if (!send) return 'ignored';
  const { campaign_id: campaignId, lead_id: leadId, user_id: userId } = send;

  switch (event.type) {
    case 'email.opened': {
      const { changes } = db.prepare(`UPDATE campaign_leads SET status = 'opened', opened_at = CURRENT_TIMESTAMP
                                      WHERE campaign_id = ? AND lead_id = ? AND status = 'sent'`).run(campaignId, leadId);
      if (changes) {
        db.prepare('UPDATE campaigns SET open_count = open_count + 1 WHERE id = ?').run(campaignId);
        db.prepare('UPDATE leads SET score = MIN(score + 5, 100), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(leadId, userId);
      }
      return 'opened';
    }

    case 'email.clicked': {
      const { changes } = db.prepare(`UPDATE campaign_leads SET status = 'clicked', clicked_at = CURRENT_TIMESTAMP
                                      WHERE campaign_id = ? AND lead_id = ? AND status IN ('sent', 'opened')`).run(campaignId, leadId);
      if (changes) {
        db.prepare('UPDATE campaigns SET click_count = click_count + 1 WHERE id = ?').run(campaignId);
        db.prepare('UPDATE leads SET score = MIN(score + 10, 100), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(leadId, userId);
      }
      return 'clicked';
    }

    // Resend sends email.bounced only for permanent rejections, so further
    // follow-ups in this campaign would bounce too and hurt sender reputation.
    case 'email.bounced': {
      db.prepare("UPDATE campaign_leads SET status = 'bounced' WHERE campaign_id = ? AND lead_id = ? AND status = 'sent'").run(campaignId, leadId);
      db.prepare("UPDATE outreach_queue SET status = 'skipped' WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'").run(campaignId, leadId);
      return 'bounced';
    }

    // Marked as spam: treat it as an opt-out from this sending account.
    // Prefer the lead's stored address, since that is what isSuppressed()
    // checks before every send.
    case 'email.complained': {
      const to = Array.isArray(event.data.to) ? event.data.to[0] : event.data.to;
      const email = send.lead_email || to;
      if (!email) return 'ignored';
      if (suppress({ userId, email, reason: 'complaint', campaignId, leadId })) {
        db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?, ?, ?, 'email', 'Marked a campaign email as spam; added to the do-not-email list')")
          .run(userId, leadId, campaignId);
      }
      return 'complained';
    }

    default:
      return 'ignored';
  }
}
