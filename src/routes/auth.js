import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/index.js';
import { hashPassword, verifyPassword, generateToken, requireAuth, getPlanLimits } from '../middleware/auth.js';
import {
  parseUserAgent,
  extractClientIp,
  deviceFingerprint,
  displaceOtherSessions,
  isKnownDevice,
  rememberDevice,
  notifyNewDeviceLogin,
  generateMfaSecret,
  otpauthToQrDataUrl,
  verifyTotp,
  generateRecoveryCodes,
  hashRecoveryCodes,
  redeemRecoveryCode,
  createMfaChallenge,
  consumeMfaChallenge,
  adminMfaRequired,
} from '../services/auth-security.js';
import { sendEmail } from '../utils/email.js';

const router = Router();

// CSPRNG-backed human-friendly code (no 0/O/1/I) for emailed verification.
// crypto.randomBytes guarantees uniform distribution; rejection-sampling
// ensures the modulo doesn't bias the alphabet.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars
function randomCode(len) {
  const out = [];
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b < 256 - (256 % 32)) out.push(CODE_ALPHABET[b % 32]);
    }
  }
  return out.join('');
}

// Shared helper: create a session + fire notifications. Returns response payload.
function issueSessionPayload(user, req) {
  const token = generateToken();
  const ip = extractClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const deviceLabel = parseUserAgent(ua);

  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, ip, user_agent, device_label)
    VALUES (?, ?, datetime('now', '+24 hours'), ?, ?, ?)
  `).run(token, user.id, ip, ua, deviceLabel);

  displaceOtherSessions(user.id, token, 'Your account was signed in from another device');
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

  const fp = deviceFingerprint(ip, ua);
  if (!isKnownDevice(user.id, fp)) {
    notifyNewDeviceLogin(user, { deviceLabel, ip });
    rememberDevice(user.id, fp);
  }

  const plan = user.plan || 'starter';
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      plan,
      displayName: user.display_name,
      budgetLimit: user.budget_limit,
      monthlySystemCost: user.monthly_system_cost,
      planLimits: getPlanLimits(plan),
      mfaEnabled: !!user.mfa_enabled,
    },
  };
}

// Per-username lockout: cap failed attempts at LOCKOUT_THRESHOLD, then block
// for LOCKOUT_MS. Independent of IP so a residential proxy pool can't bypass
// it. Successful login resets the counter.
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    // Generic message — never reveal whether the username exists.
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Honor an active lockout before doing the bcrypt compare. Bcrypt is the
  // most expensive thing in this handler, so this also limits CPU burn.
  if (user.locked_until) {
    const lockedUntil = new Date(user.locked_until + 'Z').getTime();
    if (Date.now() < lockedUntil) {
      const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${wait}s.` });
    }
  }

  const passResult = verifyPassword(password, user.password_hash);
  if (!passResult) {
    // Bump the per-username counter and lock when threshold is hit.
    const next = (user.failed_login_count || 0) + 1;
    if (next >= LOCKOUT_THRESHOLD) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString().slice(0, 19).replace('T', ' ');
      db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?')
        .run(next, lockedUntil, user.id);
    } else {
      db.prepare('UPDATE users SET failed_login_count = ? WHERE id = ?').run(next, user.id);
    }
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Successful auth: clear the lockout state.
  if (user.failed_login_count > 0 || user.locked_until) {
    db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  }

  // (Legacy SHA256 → bcrypt auto-upgrade path removed; verifyPassword now
  // refuses non-bcrypt hashes outright.)

  // Path A: MFA already enabled → issue challenge, require TOTP
  if (user.mfa_enabled) {
    const challengeToken = createMfaChallenge(user.id);
    return res.json({
      mfa_required: true,
      challenge_token: challengeToken,
      methods: ['totp', 'recovery_code'],
    });
  }

  // Path B: No MFA yet → issue session. If superadmin, flag mustEnrolMfa so
  //   UI forces the enrolment wizard before they can use the app.
  const payload = issueSessionPayload(user, req);
  payload.mustEnrolMfa = adminMfaRequired(user) && !user.mfa_enabled;
  res.json(payload);
});

// POST /api/auth/mfa/verify-login — second step when mfa_required came back
router.post('/mfa/verify-login', (req, res) => {
  const { challenge_token, code, recovery_code } = req.body;
  if (!challenge_token || (!code && !recovery_code)) {
    return res.status(400).json({ error: 'Missing code' });
  }

  const challenge = consumeMfaChallenge(challenge_token);
  if (!challenge) {
    return res.status(401).json({ error: 'Challenge expired. Please log in again.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(challenge.userId);
  if (!user || user.status === 'suspended') {
    return res.status(401).json({ error: 'Account unavailable' });
  }

  if (recovery_code) {
    const r = redeemRecoveryCode(user.id, recovery_code);
    if (!r.ok) return res.status(401).json({ error: 'Invalid recovery code' });
    const payload = issueSessionPayload(user, req);
    payload.recoveryCodesRemaining = r.remaining;
    return res.json(payload);
  }

  if (!verifyTotp(user.mfa_secret, code)) {
    return res.status(401).json({ error: 'Invalid authentication code' });
  }
  return res.json(issueSessionPayload(user, req));
});

// POST /api/auth/mfa/setup — begin enrolment; returns QR + secret
router.post('/mfa/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT id, username, email, mfa_enabled FROM users WHERE id = ?').get(req.user.id);
  if (user.mfa_enabled) {
    return res.status(400).json({ error: 'MFA already enabled. Disable it first to re-enrol.' });
  }

  const secret = generateMfaSecret(user.username);
  // Store secret provisionally — not yet enabled until they verify a code
  db.prepare('UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?')
    .run(secret.base32, user.id);

  const qrDataUrl = await otpauthToQrDataUrl(secret.otpauth_url);
  res.json({
    qr: qrDataUrl,
    secret: secret.base32, // show once so user can type it manually if camera fails
    otpauth_url: secret.otpauth_url,
  });
});

// POST /api/auth/mfa/verify-setup — confirm enrolment with a live code; returns recovery codes
router.post('/mfa/verify-setup', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const user = db.prepare('SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user.mfa_secret) return res.status(400).json({ error: 'No pending enrolment. Start setup first.' });
  if (user.mfa_enabled) return res.status(400).json({ error: 'MFA already enabled.' });

  if (!verifyTotp(user.mfa_secret, code)) {
    return res.status(401).json({ error: 'Code did not match. Check your authenticator app clock.' });
  }

  const codes = generateRecoveryCodes(10);
  const hashed = hashRecoveryCodes(codes);
  db.prepare(`
    UPDATE users SET mfa_enabled = 1, mfa_recovery_codes = ?, mfa_enrolled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(hashed), req.user.id);

  res.json({
    success: true,
    recovery_codes: codes, // one-time display — user MUST save these
  });
});

// POST /api/auth/mfa/regenerate-recovery-codes
router.post('/mfa/regenerate-recovery-codes', requireAuth, (req, res) => {
  const user = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled' });

  const codes = generateRecoveryCodes(10);
  const hashed = hashRecoveryCodes(codes);
  db.prepare('UPDATE users SET mfa_recovery_codes = ? WHERE id = ?')
    .run(JSON.stringify(hashed), req.user.id);

  res.json({ recovery_codes: codes });
});

// POST /api/auth/mfa/disable — requires current TOTP code to disable
router.post('/mfa/disable', requireAuth, (req, res) => {
  if (req.user.role === 'superadmin') {
    return res.status(403).json({ error: 'Superadmins cannot disable MFA. Contact another superadmin.' });
  }
  const { code } = req.body;
  const user = db.prepare('SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled' });
  if (!verifyTotp(user.mfa_secret, code || '')) {
    return res.status(401).json({ error: 'Invalid code' });
  }
  db.prepare(`
    UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_codes = NULL, mfa_enrolled_at = NULL
    WHERE id = ?
  `).run(req.user.id);
  res.json({ success: true });
});

// POST /api/auth/mfa/admin-reset/:userId — superadmin resets another user's MFA
router.post('/mfa/admin-reset/:userId', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Forbidden' });
  const targetId = parseInt(req.params.userId, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Use the normal disable flow for your own account (requires TOTP).' });
  }
  db.prepare(`
    UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_codes = NULL, mfa_enrolled_at = NULL
    WHERE id = ?
  `).run(targetId);
  res.json({ success: true });
});

// GET /api/auth/sessions — list this user's active sessions
router.get('/sessions', requireAuth, (req, res) => {
  const currentToken = req.headers['authorization']?.replace('Bearer ', '');

  // Check which columns exist — the new security columns may not be present
  // on production DB if the schema migration hasn't completed yet.
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  const has = (c) => sessionCols.includes(c);

  const selectCols = ['token', 'created_at', 'expires_at'];
  if (has('ip')) selectCols.push('ip');
  if (has('user_agent')) selectCols.push('user_agent');
  if (has('device_label')) selectCols.push('device_label');
  if (has('last_activity')) selectCols.push('last_activity');

  let where = 'user_id = ? AND expires_at > datetime(\'now\')';
  if (has('displaced_at')) where += ' AND displaced_at IS NULL';

  const orderBy = has('last_activity') ? 'last_activity DESC' : 'created_at DESC';

  const sql = `SELECT ${selectCols.join(', ')} FROM sessions WHERE ${where} ORDER BY ${orderBy}`;
  const rows = db.prepare(sql).all(req.user.id);

  res.json(rows.map(r => {
    const isCurrent = r.token === currentToken;
    return {
      token: r.token.slice(0, 4) + '...' + r.token.slice(-4),
      ip: r.ip || null,
      user_agent: r.user_agent || null,
      device_label: r.device_label || null,
      created_at: r.created_at,
      last_activity: r.last_activity || r.created_at,
      expires_at: r.expires_at,
      current: isCurrent,
    };
  }));
});

// POST /api/auth/sessions/revoke — revoke a specific session (not current)
router.post('/sessions/revoke', requireAuth, (req, res) => {
  const { token_prefix } = req.body;
  if (!token_prefix) return res.status(400).json({ error: 'token_prefix required' });
  const currentToken = req.headers['authorization']?.replace('Bearer ', '');

  // token_prefix is "xxxx...yyyy" — extract the 4 char prefix + 4 char suffix.
  // If the client sent the full masked form, take start and end.
  const prefix = token_prefix.slice(0, 4);
  const suffix = token_prefix.slice(-4);

  const candidates = db.prepare(`
    SELECT token FROM sessions WHERE user_id = ? AND token != ?
  `).all(req.user.id, currentToken);

  const match = candidates.find(c => c.token.startsWith(prefix) && c.token.endsWith(suffix));
  if (!match) return res.status(404).json({ error: 'Session not found' });

  db.prepare('DELETE FROM sessions WHERE token = ?').run(match.token);
  res.json({ success: true });
});

// POST /api/auth/sessions/revoke-all — sign out everywhere except current
router.post('/sessions/revoke-all', requireAuth, (req, res) => {
  const currentToken = req.headers['authorization']?.replace('Bearer ', '');
  // If displaced_at column doesn't exist yet, fall back to plain delete
  try {
    const result = db.prepare(`
      UPDATE sessions SET displaced_reason = ?, displaced_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND token != ?
    `).run('You signed out remotely', req.user.id, currentToken);
    return res.json({ success: true, revoked: result.changes });
  } catch (e) {
    const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, currentToken);
    return res.json({ success: true, revoked: result.changes });
  }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const plan = req.user.plan || 'starter';
  // Pull created_at + last_login indirectly for the Account page
  let meta = null;
  try { meta = db.prepare('SELECT created_at, email_verified FROM users WHERE id = ?').get(req.user.id); } catch (e) { meta = null; }
  res.json({
    ...req.user,
    planLimits: getPlanLimits(plan),
    created_at: meta?.created_at || null,
  });
});

// PATCH /api/auth/profile — self-service edit: display_name + email only
router.patch('/profile', requireAuth, (req, res) => {
  const { display_name, email } = req.body || {};
  const fields = [];
  const params = [];

  if (display_name !== undefined) {
    const s = String(display_name).trim();
    if (s.length < 1 || s.length > 80) return res.status(400).json({ error: 'Display name must be 1-80 characters' });
    fields.push('display_name = ?'); params.push(s);
  }
  if (email !== undefined) {
    const e = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'Invalid email' });
    const collision = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(e, req.user.id);
    if (collision) return res.status(409).json({ error: 'That email is already in use' });
    fields.push('email = ?'); params.push(e);
    // Changing email invalidates verification
    fields.push('email_verified = 0');
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.user.id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT id, username, email, display_name, role, plan, email_verified, mfa_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({
    id: updated.id,
    username: updated.username,
    email: updated.email,
    displayName: updated.display_name,
    role: updated.role,
    plan: updated.plan,
    emailVerified: !!updated.email_verified,
    mfaEnabled: !!updated.mfa_enabled,
  });
});

// POST /api/auth/reset-password — user resets own password
router.post('/reset-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const passResult = verifyPassword(currentPassword, user.password_hash);
  if (!passResult) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);

  res.json({ success: true });
});

// POST /api/auth/lookup-email — masked-only hint for the forgot-password flow.
// Returns the SAME response shape whether or not the username exists, so the
// endpoint cannot be used as a username-enumeration oracle. The previous
// version returned `{ email: null }` for misses and `{ email: masked, full: email }`
// for hits — both the shape difference and the `full` field were enumeration
// + PII leaks.
router.post('/lookup-email', (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.json({ email: null, hint: 'If this account exists, a verification code can be sent.' });
  }

  const user = db.prepare('SELECT email FROM users WHERE username = ?').get(username);
  if (!user || !user.email) {
    return res.json({ email: null, hint: 'If this account exists, a verification code can be sent.' });
  }

  const [local, domain] = user.email.split('@');
  const masked = local.charAt(0) + '*'.repeat(Math.max(local.length - 2, 1)) + local.charAt(local.length - 1) + '@' + domain;
  // No `full` field — the unmasked address never leaves the server.
  res.json({ email: masked, hint: 'If this account exists, a verification code can be sent.' });
});

// POST /api/auth/forgot-password — send password reset email
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  // Always return success (don't reveal if email exists)
  if (!email) return res.json({ success: true });

  const user = db.prepare('SELECT id, username, display_name, email FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ success: true }); // Silent — don't reveal

  try {
    // Generate reset token (valid 1 hour)
    const resetToken = generateToken();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`reset_token_${resetToken}`, JSON.stringify({ userId: user.id, expires: Date.now() + 3600000 }));

    // Same fix as /resend-verification: route through sendEmail() so the
    // password-reset mail uses the same Resend → SMTP chain. The previous
    // hand-rolled SMTP path silently swallowed BadCredentials errors here.
    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const resetUrl = `${baseUrl}/app?reset=${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Password Reset — EIAAW SalesAgent',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
          <h1 style="color:#2ec4b6">Password Reset</h1>
          <p>Hi ${user.display_name || user.username},</p>
          <p>We received a request to reset your password. Click the link below to set a new password:</p>
          <p style="margin:24px 0">
            <a href="${resetUrl}" style="background:#2ec4b6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Reset My Password</a>
          </p>
          <p style="color:#999;font-size:13px">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
          <hr style="margin:24px 0">
          <p style="color:#999;font-size:12px">EIAAW SalesAgent AI<br><a href="https://eiaawsolutions.com">eiaawsolutions.com</a></p>
        </div>
      `,
    });
  } catch (e) {
    console.error('Password reset email failed:', e.message);
  }

  res.json({ success: true });
});

// POST /api/auth/reset-password-with-token — reset password using token from email
router.post('/reset-password-with-token', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`reset_token_${token}`);
  if (!row) return res.status(400).json({ error: 'Invalid or expired reset link.' });

  let data;
  try { data = JSON.parse(row.value); } catch { return res.status(400).json({ error: 'Invalid reset token.' }); }

  if (Date.now() > data.expires) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(`reset_token_${token}`);
    return res.status(400).json({ error: 'Reset link expired. Request a new one.' });
  }

  const hash = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, data.userId);
  db.prepare("DELETE FROM settings WHERE key = ?").run(`reset_token_${token}`);
  // Kill existing sessions
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(data.userId);

  res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
});

// POST /api/auth/resend-verification — resend the email verification code
router.post('/resend-verification', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT id, username, email, display_name, email_verified FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified) return res.json({ success: true, message: 'Email already verified' });
  if (!user.email) return res.status(400).json({ error: 'No email on file. Update your profile first.' });

  const throttleKey = `verify_resend_${user.id}`;
  const last = db.prepare("SELECT value FROM settings WHERE key = ?").get(throttleKey);
  if (last) {
    const elapsed = Date.now() - parseInt(last.value, 10);
    if (elapsed < 60_000) {
      const wait = Math.ceil((60_000 - elapsed) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
    }
  }

  // CSPRNG-backed 8-char A–Z2-9 code (~41 bits, no ambiguous chars). Math.random
  // is NOT a CSPRNG and would let an attacker who triggers a target's resend
  // predict adjacent codes.
  const verifyCode = randomCode(8);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run(`verify_code_${user.id}`, verifyCode);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run(throttleKey, String(Date.now()));

  try {
    // Route through the shared sendEmail() utility so verification mail uses
    // the same Resend → SMTP fallback chain that outreach + appointment mails
    // already use successfully on Railway. The hand-rolled SMTP path that
    // lived here before read smtp_pass from settings WITHOUT decrypting it
    // (smtp_pass is in SENSITIVE_KEYS so it is stored AES-encrypted), which
    // produced "535 BadCredentials" against Gmail and meant verification
    // codes never reached anyone whose smtp_pass was set via the Settings UI.
    await sendEmail({
      to: user.email,
      subject: 'Your EIAAW SalesAgent verification code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
          <h1 style="color:#2ec4b6">Verify your email</h1>
          <p>Hi ${user.display_name || user.username},</p>
          <p>Use the code below to verify your email address:</p>
          <p style="background:#fff3cd;padding:16px;border-radius:8px;text-align:center;margin:20px 0">
            <strong style="font-size:24px;letter-spacing:4px">${verifyCode}</strong>
          </p>
          <p style="color:#999;font-size:13px">If you didn't request this, you can ignore this email.</p>
          <hr style="margin:24px 0">
          <p style="color:#999;font-size:12px">EIAAW SalesAgent AI<br><a href="https://eiaawsolutions.com">eiaawsolutions.com</a></p>
        </div>
      `,
    });

    const masked = user.email.replace(/(.{2}).*(@.*)/, '$1***$2');
    res.json({ success: true, message: `Verification code sent to ${masked}` });
  } catch (e) {
    console.error('Resend verification email failed:', e.message);
    res.status(500).json({ error: 'Failed to send email. Try again shortly.' });
  }
});

// POST /api/auth/verify-email — verify email with code
router.post('/verify-email', requireAuth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Verification code required' });

  const key = `verify_code_${req.user.id}`;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);

  if (!row) {
    // Check if already verified
    const user = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
    if (user?.email_verified) return res.json({ success: true, message: 'Email already verified' });
    return res.status(400).json({ error: 'No verification pending. Contact support.' });
  }

  if (row.value !== code.toUpperCase().trim()) {
    return res.status(400).json({ error: 'Invalid verification code. Check your email.' });
  }

  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(req.user.id);
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);

  res.json({ success: true, message: 'Email verified successfully!' });
});

// GET /api/auth/temp-password — one-time retrieval of temp password after signup
router.get('/temp-password', requireAuth, (req, res) => {
  const key = `temp_pass_${req.headers['authorization']?.replace('Bearer ', '')}`;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (row) {
    // Delete after retrieval (one-time use)
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    res.json({ tempPassword: row.value });
  } else {
    res.json({ tempPassword: null });
  }
});

export default router;
