import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { sendEmail } from '../utils/email.js';

// -- Device fingerprinting ---------------------------------------------------

const UA_BROWSER = /(Chrome|Safari|Firefox|Edg|Edge|Opera|OPR)\/[\d.]+/;
const UA_OS = /(Windows NT [\d.]+|Mac OS X [\d_.]+|Android \d+|iPhone OS [\d_]+|Linux)/;

export function parseUserAgent(ua = '') {
  const browser = (ua.match(UA_BROWSER) || [])[0] || 'Unknown browser';
  const os = (ua.match(UA_OS) || [])[0] || 'Unknown OS';
  return `${browser.split('/')[0]} on ${os.replace(/_/g, '.').split(' ').slice(0, 3).join(' ')}`;
}

export function extractClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Stable fingerprint used to remember whether a device has been notified before
export function deviceFingerprint(ip, userAgent) {
  return crypto.createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 16);
}

// -- Session displacement ----------------------------------------------------

/**
 * Displace every other active session for this user.
 * The displaced session rows stay in the DB (with displaced_at + reason) so that
 * when the displaced client calls a protected endpoint, requireAuth can return
 * a specific "displaced" error instead of generic "invalid token".
 */
export function displaceOtherSessions(userId, newToken, reason = 'New login elsewhere') {
  db.prepare(`
    UPDATE sessions
       SET displaced_reason = ?, displaced_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND token != ? AND displaced_at IS NULL
  `).run(reason, userId, newToken);
}

// -- New-device email notification ------------------------------------------

export function isKnownDevice(userId, fingerprint) {
  const row = db.prepare('SELECT known_devices FROM users WHERE id = ?').get(userId);
  try {
    const list = JSON.parse(row?.known_devices || '[]');
    return list.includes(fingerprint);
  } catch {
    return false;
  }
}

export function rememberDevice(userId, fingerprint) {
  const row = db.prepare('SELECT known_devices FROM users WHERE id = ?').get(userId);
  let list = [];
  try { list = JSON.parse(row?.known_devices || '[]'); } catch {}
  if (!list.includes(fingerprint)) {
    list.push(fingerprint);
    // Keep last 20 devices
    if (list.length > 20) list = list.slice(-20);
    db.prepare('UPDATE users SET known_devices = ? WHERE id = ?').run(JSON.stringify(list), userId);
  }
}

export async function notifyNewDeviceLogin(user, { deviceLabel, ip, time }) {
  if (!user.email) return;
  const when = time || new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  sendEmail({
    to: user.email,
    subject: `New sign-in to your EIAAW account`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
        <h2 style="color:#11766A;margin-bottom:16px">New sign-in detected</h2>
        <p style="font-size:15px;line-height:1.6;color:#1A2A2E">Hi ${user.display_name || user.username},</p>
        <p style="font-size:15px;line-height:1.6;color:#1A2A2E">We noticed a sign-in to your EIAAW Solutions account from a new device:</p>
        <div style="background:#F3EDE0;border-radius:10px;padding:16px;margin:16px 0;font-size:14px;line-height:1.7;color:#1A2A2E">
          <div><strong>Device:</strong> ${deviceLabel}</div>
          <div><strong>IP address:</strong> ${ip}</div>
          <div><strong>Time:</strong> ${when}</div>
        </div>
        <p style="font-size:14px;color:#1A2A2E">If this was you, you can ignore this email.</p>
        <p style="font-size:14px;color:#B4412B"><strong>If this wasn't you</strong>, change your password immediately and enable 2-factor authentication in Settings.</p>
        <hr style="margin:24px 0;border:none;border-top:1px solid #E8DFCC">
        <p style="font-size:11px;color:#6B7A7F;text-align:center">EIAAW Solutions &mdash; AI-Human Partnerships</p>
      </div>
    `,
  }).catch(err => console.error('[new-device-email] failed:', err.message));
}

// -- TOTP / MFA --------------------------------------------------------------

export function generateMfaSecret(username) {
  return speakeasy.generateSecret({
    name: `EIAAW Solutions (${username})`,
    issuer: 'EIAAW Solutions',
    length: 20,
  });
}

export async function otpauthToQrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, { width: 240, margin: 1 });
}

export function verifyTotp(secretBase32, token) {
  if (!secretBase32 || !token) return false;
  return speakeasy.totp.verify({
    secret: secretBase32,
    encoding: 'base32',
    token: token.replace(/\s+/g, ''),
    window: 1, // allow ±30s drift
  });
}

// -- Recovery codes ----------------------------------------------------------

// Generate 10 human-friendly codes like "A3F7-9K2P" — display ONCE, store hashed
export function generateRecoveryCodes(count = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 ambiguity
  const codes = [];
  for (let i = 0; i < count; i++) {
    const rand = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
    codes.push(`${rand(4)}-${rand(4)}`);
  }
  return codes;
}

export function hashRecoveryCodes(codes) {
  return codes.map(c => bcrypt.hashSync(c, 8));
}

/**
 * Try to match `providedCode` against the user's stored hashed codes.
 * If it matches, returns true AND removes the used code from storage (one-time use).
 */
export function redeemRecoveryCode(userId, providedCode) {
  const row = db.prepare('SELECT mfa_recovery_codes FROM users WHERE id = ?').get(userId);
  let hashes = [];
  try { hashes = JSON.parse(row?.mfa_recovery_codes || '[]'); } catch {}
  const normalised = providedCode.trim().toUpperCase();
  for (let i = 0; i < hashes.length; i++) {
    if (bcrypt.compareSync(normalised, hashes[i])) {
      hashes.splice(i, 1);
      db.prepare('UPDATE users SET mfa_recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), userId);
      return { ok: true, remaining: hashes.length };
    }
  }
  return { ok: false };
}

// -- MFA challenge tokens (for the 2-step login flow) ------------------------

// Short-lived opaque token returned after password is correct but before TOTP.
// Stored in settings with key `mfa_challenge_<token>` for 5 minutes.
export function createMfaChallenge(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000;
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run(`mfa_challenge_${token}`, JSON.stringify({ userId, expiresAt }));
  return token;
}

export function consumeMfaChallenge(token) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`mfa_challenge_${token}`);
  if (!row) return null;
  try {
    const data = JSON.parse(row.value);
    // Single-use: delete regardless
    db.prepare('DELETE FROM settings WHERE key = ?').run(`mfa_challenge_${token}`);
    if (data.expiresAt < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// -- Admin MFA enforcement ---------------------------------------------------

export function adminMfaRequired(user) {
  return user.role === 'superadmin';
}
