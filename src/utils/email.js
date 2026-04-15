import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { decrypt } from './crypto.js';

/**
 * Send an email using the best available method:
 * 1. Resend API (if resend_api_key is configured) — works on Railway, no SMTP needed
 * 2. SMTP (Gmail, etc.) — fallback, may be blocked on some cloud providers
 */
export async function sendEmail({ to, subject, html, from, attachments, icalEvent }) {
  // Try Resend first
  const resendRow = db.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").get();
  const resendKey = resendRow?.value ? decrypt(resendRow.value) : '';

  if (resendKey && resendKey.length > 5 && !resendKey.includes('•')) {
    console.log('Sending email via Resend to:', to);
    return sendViaResend(resendKey, { to, subject, html, from, attachments, icalEvent });
  }

  // Fall back to SMTP
  console.log('Sending email via SMTP to:', to, '(Resend key:', resendKey ? 'present but invalid' : 'not configured', ')');
  return sendViaSMTP({ to, subject, html, from, attachments, icalEvent });
}

async function sendViaResend(apiKey, { to, subject, html, from, attachments, icalEvent }) {
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
  if (!res.ok) throw new Error(data.message || `Resend error ${res.status}`);
  return { method: 'resend', id: data.id };
}

async function sendViaSMTP({ to, subject, html, from, attachments, icalEvent }) {
  const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
  const smtpPort = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || '587');
  const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
  const smtpPass = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value;
  const fromEmail = from || db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || smtpUser;

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
  if (icalEvent) mailOpts.icalEvent = icalEvent;
  if (attachments) mailOpts.attachments = attachments;

  await transporter.sendMail(mailOpts);
  return { method: 'smtp' };
}
