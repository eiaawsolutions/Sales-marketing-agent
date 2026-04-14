import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { decrypt } from './crypto.js';

/**
 * Send an email using the best available method:
 * 1. Resend API (if resend_api_key is configured) — works on Railway, no SMTP needed
 * 2. SMTP (Gmail, etc.) — fallback, may be blocked on some cloud providers
 */
export async function sendEmail({ to, subject, html, from }) {
  // Try Resend first
  const resendKey = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").get()?.value) || '';
  if (resendKey) {
    return sendViaResend(resendKey, { to, subject, html, from });
  }

  // Fall back to SMTP
  return sendViaSMTP({ to, subject, html, from });
}

async function sendViaResend(apiKey, { to, subject, html, from }) {
  const fromEmail = from || db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || 'noreply@eiaawsolutions.com';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromEmail, to: [to], subject, html }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Resend error ${res.status}`);
  return { method: 'resend', id: data.id };
}

async function sendViaSMTP({ to, subject, html, from }) {
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

  await transporter.sendMail({ from: fromEmail, to, subject, html });
  return { method: 'smtp' };
}
