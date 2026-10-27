/**
 * Where a prospect's reply goes, so the agent can read it.
 *
 * With INBOUND_REPLY_DOMAIN set (a Resend receiving domain — the account's
 * <id>.resend.app address, or a subdomain with Resend's MX record), outreach
 * is sent with Reply-To r-<leadId>-<token>@<domain>. Resend posts each reply
 * to /api/tracking/webhook as email.received; the token proves the address
 * was minted here for that lead, so nobody can file a reply against a lead
 * by guessing ids. The reply is then forwarded to the account's own inbox.
 *
 * Without it, Reply-To stays the account's inbox and replies are logged by
 * pasting them in, as before.
 */
import { signReply, verifyReply } from '../utils/tracking-token.js';

export function inboundDomain() {
  const d = String(process.env.INBOUND_REPLY_DOMAIN || '').trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/** The Reply-To for outreach to this lead, or null when inbound is off. */
export function replyAddressFor(leadId) {
  const domain = inboundDomain();
  if (!domain || !Number.isInteger(Number(leadId))) return null;
  return `r-${Number(leadId)}-${signReply(Number(leadId))}@${domain}`;
}

/** The lead a received address belongs to, or null if it is not one of ours. */
export function leadIdFromAddress(address) {
  const domain = inboundDomain();
  if (!domain) return null;
  const m = String(address || '').trim().toLowerCase().match(/<?r-(\d+)-([0-9a-f]{16})@([a-z0-9.-]+)>?$/);
  if (!m || m[3] !== domain) return null;
  const leadId = Number(m[1]);
  return verifyReply(leadId, m[2]) ? leadId : null;
}
