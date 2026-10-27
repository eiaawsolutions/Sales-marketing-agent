import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { decrypt } from './crypto.js';

/**
 * Send an email using the best available method:
 * 1. Resend API (if resend_api_key is configured) — works on Railway, no SMTP needed
 * 2. SMTP (Gmail, etc.) — fallback, may be blocked on some cloud providers
 *
 * `headers` carries extra message headers, e.g. List-Unsubscribe on outreach.
 */
const DEFAULT_SENDER = { name: 'EIAAW SalesAgent', address: 'sales@eiaawsolutions.com' };

// A display name goes inside a From header. Strip anything that could end the
// header (CR/LF) or smuggle in a second address (quotes, angle brackets).
export function safeDisplayName(name) {
  return String(name || '').replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function addressOf(value) {
  const s = String(value || '').trim();
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/);
  return m ? m[1] : s;
}

function formatFrom(name, address) {
  const n = safeDisplayName(name);
  return n ? `"${n}" <${address}>` : address;
}

/**
 * `fromName` is the person/business the email is sent for (account outreach).
 * `from` is a bare address and is only passed for a customer domain already
 * verified for sending (account-profile.js senderFor) — any other address
 * would fail DMARC, so without it mail goes from EIAAW's verified domain under
 * the customer's name, with replies routed by `replyTo`.
 */
// The Resend API key: the DB row wins over env so the in-app Settings UI keeps
// working, but env (RESEND_API_KEY) acts as a fresh-install / Railway-only
// fallback. Empty string when neither is usable.
// For logs: "a***@domain" — enough to trace a delivery, not to read an address.
function maskAddress(to) {
  return String(Array.isArray(to) ? to[0] : to || '').replace(/^(.)[^@]*@/, '$1***@');
}

export function resendApiKey() {
  const resendRow = db.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").get();
  const dbResendKey = resendRow?.value ? decrypt(resendRow.value) : '';
  const key = (dbResendKey && dbResendKey.length > 5 && !dbResendKey.includes('•')) ? dbResendKey : (process.env.RESEND_API_KEY || '');
  return key && key.length > 5 && !key.includes('•') ? key : '';
}

export async function sendEmail({ to, subject, html, from, fromName, replyTo, attachments, icalEvent, headers }) {
  const resendKey = resendApiKey();
  if (resendKey) {
    console.log('Sending email via Resend to:', maskAddress(to));
    return sendViaResend(resendKey, { to, subject, html, from, fromName, replyTo, attachments, icalEvent, headers });
  }

  // Fall back to SMTP
  console.log('Sending email via SMTP to:', maskAddress(to), '(no Resend key configured)');
  return sendViaSMTP({ to, subject, html, from, fromName, replyTo, attachments, icalEvent, headers });
}

async function sendViaResend(apiKey, { to, subject, html, from, fromName, replyTo, attachments, icalEvent, headers }) {
  const configuredFrom = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || '';

  // Resend requires a verified domain. Free email providers (gmail, yahoo, etc.) can't be used.
  // A per-account `from` is pre-checked against verified domains; otherwise the
  // verified eiaawsolutions.com address (Settings, or the default).
  let fromEmail;
  if (from) {
    fromEmail = formatFrom(fromName, from);
  } else if (configuredFrom.includes('@eiaawsolutions.com')) {
    fromEmail = fromName ? formatFrom(fromName, addressOf(configuredFrom)) : configuredFrom;
  } else {
    fromEmail = formatFrom(fromName || DEFAULT_SENDER.name, DEFAULT_SENDER.address);
  }

  const payload = { from: fromEmail, to: [to], subject, html };
  if (replyTo) payload.reply_to = replyTo;

  // Add .ics calendar invite as attachment for Resend
  if (icalEvent?.content) {
    payload.attachments = [
      { filename: icalEvent.filename || 'invite.ics', content: Buffer.from(icalEvent.content).toString('base64') },
    ];
    // Also add as inline calendar header so email clients show "Add to Calendar"
    payload.headers = { 'Content-Type': 'multipart/mixed' };
  }

  if (headers) payload.headers = { ...(payload.headers || {}), ...headers };

  // Add any additional attachments
  if (attachments?.length) {
    payload.attachments = [...(payload.attachments || []), ...attachments];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    // Surface the full Resend error so deliverability problems (unverified
    // domain, sandbox-only address, rate limit, daily cap) are visible in
    // logs instead of bubbling up as a generic "Resend error 4xx".
    console.error('[Resend] send failed:', res.status, JSON.stringify(data), 'to:', maskAddress(to));
    throw new Error(data.message || `Resend error ${res.status}`);
  }
  console.log('[Resend] sent id=' + data.id, 'to:', maskAddress(to));
  return { method: 'resend', id: data.id };
}

async function sendViaSMTP({ to, subject, html, from, fromName, replyTo, attachments, icalEvent, headers }) {
  // smtp_pass is in SENSITIVE_KEYS and stored AES-encrypted. Decrypt before
  // handing to nodemailer or every send dies with "535 BadCredentials".
  // Fall back to env vars (SMTP_USER / SMTP_PASS / etc.) when settings are
  // empty so a fresh install with only Railway env vars still works.
  const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value || process.env.SMTP_HOST;
  const smtpPort = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || process.env.SMTP_PORT || '587');
  const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value || process.env.SMTP_USER;
  const smtpPass = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value) || process.env.SMTP_PASS;
  const baseFrom = from || db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || process.env.FROM_EMAIL || smtpUser;
  const fromEmail = fromName ? formatFrom(fromName, addressOf(baseFrom)) : baseFrom;

  if (!smtpUser || !smtpHost) throw new Error('Email not configured. Add SMTP or Resend API key in Settings.');

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  const mailOpts = { from: fromEmail, to, subject, html };
  if (replyTo) mailOpts.replyTo = replyTo;
  if (icalEvent) mailOpts.icalEvent = icalEvent;
  if (attachments) mailOpts.attachments = attachments;
  if (headers) mailOpts.headers = headers;

  await transporter.sendMail(mailOpts);
  return { method: 'smtp' };
}
