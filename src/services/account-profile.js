/**
 * The account brief: who the account sells to, what it offers, the claims it
 * may make, and who its email comes from. Every customer-facing thing the
 * agent produces — outreach, lead scoring, the voice assistant, meeting
 * invites — is written from this, so a customer's prospects hear about the
 * customer's offer and never about EIAAW's.
 */
import db from '../db/index.js';
import { isFounderHq } from '../config/hq.js';
import { normalizeEmail } from '../utils/normalize.js';

export const TONES = {
  warm: 'Warm and professional',
  direct: 'Direct and brief',
  formal: 'Formal (GLC / public sector)',
};

const TEXT_LIMITS = {
  business_name: 120, sender_name: 80, sender_title: 80, offer: 1500,
  proof_points: 1500, call_to_action: 300, voice_notes: 1500,
};

const EMPTY = {
  business_name: null, sender_name: null, sender_title: null, reply_to_email: null, from_email: null,
  website: null, offer: null, proof_points: null, call_to_action: null, tone: 'warm',
  meeting_link: null, voice_notes: null, outreach_approval: 1,
};

export function getProfile(userId) {
  const row = db.prepare('SELECT * FROM account_profiles WHERE user_id = ?').get(userId);
  return { ...EMPTY, ...(row || {}), user_id: userId };
}

export function approvalRequired(userId) {
  return getProfile(userId).outreach_approval !== 0;
}

export function isHqAccount(userId) {
  return isFounderHq(db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email);
}

function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  return s ? s.slice(0, max) : null;
}

function cleanHttpsUrl(v) {
  const s = cleanText(v, 500);
  if (!s) return { value: null };
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return { error: 'must start with https://' };
    return { value: u.toString() };
  } catch { return { error: 'is not a valid link' }; }
}

/** Validate and store. Returns { profile } or { errors: { field: message } }. */
export function saveProfile(userId, input = {}) {
  const errors = {};
  const out = {};
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    if (field in input) out[field] = cleanText(input[field], max);
  }
  for (const field of ['reply_to_email', 'from_email']) {
    if (!(field in input)) continue;
    const raw = cleanText(input[field], 254);
    if (!raw) { out[field] = null; continue; }
    const email = normalizeEmail(raw);
    if (!email) errors[field] = 'is not a valid email address';
    else out[field] = email;
  }
  for (const field of ['website', 'meeting_link']) {
    if (!(field in input)) continue;
    const { value, error } = cleanHttpsUrl(input[field]);
    if (error) errors[field] = error; else out[field] = value;
  }
  if ('tone' in input) {
    if (!(input.tone in TONES)) errors.tone = 'must be one of: ' + Object.keys(TONES).join(', ');
    else out.tone = input.tone;
  }
  if ('outreach_approval' in input) {
    out.outreach_approval = input.outreach_approval === false || input.outreach_approval === 0 || input.outreach_approval === '0' ? 0 : 1;
  }
  if (Object.keys(errors).length) return { errors };

  const merged = { ...getProfile(userId), ...out };
  db.prepare(`
    INSERT INTO account_profiles (user_id, business_name, sender_name, sender_title, reply_to_email, from_email, website,
      offer, proof_points, call_to_action, tone, meeting_link, voice_notes, outreach_approval, updated_at)
    VALUES (@user_id, @business_name, @sender_name, @sender_title, @reply_to_email, @from_email, @website,
      @offer, @proof_points, @call_to_action, @tone, @meeting_link, @voice_notes, @outreach_approval, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      business_name = excluded.business_name, sender_name = excluded.sender_name, sender_title = excluded.sender_title,
      reply_to_email = excluded.reply_to_email, from_email = excluded.from_email, website = excluded.website,
      offer = excluded.offer, proof_points = excluded.proof_points, call_to_action = excluded.call_to_action,
      tone = excluded.tone, meeting_link = excluded.meeting_link, voice_notes = excluded.voice_notes,
      outreach_approval = excluded.outreach_approval, updated_at = CURRENT_TIMESTAMP
  `).run({ ...merged, user_id: userId });
  return { profile: getProfile(userId) };
}

// The platform's own sending domain. Only EIAAW's account may put its own
// address in From; every customer sends from here under their own name.
const PLATFORM_DOMAIN = 'eiaawsolutions.com';

// Domains whose DNS (SPF/DKIM) EIAAW has verified in Resend for one account,
// held per account (setting verified_sender_domains_<userId>) after that
// customer adds the records. A from_email on any other domain is ignored, so
// mail never fails DMARC and no account can send as another's domain.
export function verifiedSenderDomains(userId) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(`verified_sender_domains_${userId}`)?.value || '';
  const domains = new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (!isHqAccount(userId)) domains.delete(PLATFORM_DOMAIN);
  return domains;
}

/**
 * How an account's outreach is addressed: the display name of the person and
 * business sending it, their own address when their domain is verified, and a
 * reply-to that reaches their inbox (not EIAAW's).
 */
export function senderFor(userId) {
  const p = getProfile(userId);
  const hq = isHqAccount(userId);
  const name = p.sender_name && p.business_name ? `${p.sender_name} (${p.business_name})` : (p.sender_name || p.business_name || null);
  const fromDomain = p.from_email ? p.from_email.split('@')[1] : null;
  const accountEmail = db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email || null;
  return {
    fromName: name || undefined,
    from: fromDomain && verifiedSenderDomains(userId).has(fromDomain) ? p.from_email : undefined,
    replyTo: p.reply_to_email || (hq ? undefined : accountEmail || undefined),
  };
}

/** True when the brief says enough to write outreach about the offer. */
export function hasOffer(profile) {
  return !!(profile.business_name && profile.offer);
}
