/**
 * Unsubscribe handling for outreach email (campaign sends + follow-up queue).
 *
 * Every outreach email gets a signed per-recipient link, filled into the
 * template's {{unsubscribe_url}} placeholder or appended as a footer when the
 * template has none, plus RFC 8058 one-click headers. Opting out adds the
 * recipient to the sending account's suppression list; both send paths check
 * that list before delivering. Terms §6 promises this, and PDPA, CAN-SPAM and
 * Gmail/Yahoo bulk-sender rules require it.
 */
import crypto from 'crypto';
import db from '../db/index.js';
import { signUnsubscribe, verifyUnsubscribe } from '../utils/tracking-token.js';

const PLACEHOLDER = /\{\{\s*unsubscribe_url\s*\}\}/g;
export const UNSUBSCRIBE_PATH = '/unsubscribe/';

export function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

export function unsubscribeUrl(baseUrl, campaignId, leadId) {
  const base = String(baseUrl || 'https://sa.eiaawsolutions.com').replace(/\/+$/, '');
  return `${base}${UNSUBSCRIBE_PATH}${campaignId}/${leadId}?t=${signUnsubscribe(campaignId, leadId)}`;
}

export function verifyUnsubscribeToken(campaignId, leadId, token) {
  return verifyUnsubscribe(campaignId, leadId, token);
}

export function isSuppressed(userId, email) {
  if (!email) return false;
  return !!db.prepare('SELECT 1 FROM email_suppressions WHERE user_id = ? AND email_hash = ?').get(userId, emailHash(email));
}

/**
 * Record an opt-out for one sending account and cancel that recipient's
 * pending follow-ups in the account's campaigns. Idempotent.
 */
export function suppress({ userId, email, reason = 'unsubscribe', campaignId = null, leadId = null }) {
  db.prepare(`INSERT OR IGNORE INTO email_suppressions (user_id, email_hash, reason, campaign_id, lead_id)
              VALUES (?, ?, ?, ?, ?)`).run(userId, emailHash(email), reason, campaignId, leadId);
  if (leadId) {
    db.prepare(`UPDATE outreach_queue SET status = 'skipped'
                WHERE lead_id = ? AND status = 'pending'
                  AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)`).run(leadId, userId);
  }
}

/**
 * Put a working unsubscribe link into an outreach email and return the
 * one-click headers to send with it. Run before injectTracking(), which
 * leaves /unsubscribe/ links alone.
 */
export function prepareOutreachEmail({ html, baseUrl, campaignId, leadId }) {
  const url = unsubscribeUrl(baseUrl, campaignId, leadId);
  let out = String(html || '').replace(PLACEHOLDER, url);
  if (!out.includes(url)) {
    const footer = `<div style="margin-top:24px;font-family:Arial,sans-serif;font-size:12px;color:#6B7A7F">`
      + `Don't want these emails? <a href="${url}" style="color:#6B7A7F;text-decoration:underline">Unsubscribe</a>.</div>`;
    out = out.includes('</body>') ? out.replace('</body>', `${footer}</body>`) : out + footer;
  }
  return {
    html: out,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
