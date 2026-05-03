import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { decrypt } from './crypto.js';

/**
 * Send an email using the best available method:
 * 1. Resend API (if resend_api_key is configured) — works on Railway, no SMTP needed
 * 2. SMTP (Gmail, etc.) — fallback, may be blocked on some cloud providers
 */
export async function sendEmail({ to, subject, html, from, replyTo, attachments, icalEvent }) {
  // Try Resend first — DB row wins over env so the in-app Settings UI keeps working,
  // but env var (RESEND_API_KEY) acts as a fresh-install / Railway-only fallback.
  const resendRow = db.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").get();
  const dbResendKey = resendRow?.value ? decrypt(resendRow.value) : '';
  const envResendKey = process.env.RESEND_API_KEY || '';
  const resendKey = (dbResendKey && dbResendKey.length > 5 && !dbResendKey.includes('•'))
    ? dbResendKey
    : envResendKey;

  if (resendKey && resendKey.length > 5 && !resendKey.includes('•')) {
    console.log('Sending email via Resend to:', to, '(source:', dbResendKey ? 'db' : 'env', ')');
    return sendViaResend(resendKey, { to, subject, html, from, replyTo, attachments, icalEvent });
  }

  // Fall back to SMTP
  console.log('Sending email via SMTP to:', to, '(Resend key:', resendKey ? 'present but invalid' : 'not configured', ')');
  return sendViaSMTP({ to, subject, html, from, replyTo, attachments, icalEvent });
}

async function sendViaResend(apiKey, { to, subject, html, from, replyTo, attachments, icalEvent }) {
  const configuredFrom = from || db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || '';

  // Resend requires a verified domain. Free email providers (gmail, yahoo, etc.) can't be used.
  // Use the verified eiaawsolutions.com domain, or fallback to Resend default.
  let fromEmail;
  if (configuredFrom && configuredFrom.includes('@eiaawsolutions.com')) {
    fromEmail = configuredFrom;
  } else {
    // Default to verified domain — this works since eiaawsolutions.com is verified in Resend
    fromEmail = 'EIAAW SalesAgent <sales@eiaawsolutions.com>';
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
    console.error('[Resend] send failed:', res.status, JSON.stringify(data), 'from:', fromEmail, 'to:', to, 'subject:', subject);
    throw new Error(data.message || `Resend error ${res.status}`);
  }
  console.log('[Resend] sent id=' + data.id, 'from:', fromEmail, 'to:', to, 'subject:', subject);
  return { method: 'resend', id: data.id };
}

async function sendViaSMTP({ to, subject, html, from, replyTo, attachments, icalEvent }) {
  // smtp_pass is in SENSITIVE_KEYS and stored AES-encrypted. Decrypt before
  // handing to nodemailer or every send dies with "535 BadCredentials".
  // Fall back to env vars (SMTP_USER / SMTP_PASS / etc.) when settings are
  // empty so a fresh install with only Railway env vars still works.
  const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value || process.env.SMTP_HOST;
  const smtpPort = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || process.env.SMTP_PORT || '587');
  const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value || process.env.SMTP_USER;
  const smtpPass = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value) || process.env.SMTP_PASS;
  const fromEmail = from || db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || process.env.FROM_EMAIL || smtpUser;

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

  await transporter.sendMail(mailOpts);
  return { method: 'smtp' };
}
