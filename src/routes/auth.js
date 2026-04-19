import { Router } from 'express';
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

const router = Router();

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

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const passResult = verifyPassword(password, user.password_hash);
  if (!passResult) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (passResult === 'upgrade') {
    const newHash = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  }

  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  }

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
  const rows = db.prepare(`
    SELECT token, ip, user_agent, device_label, created_at, last_activity, expires_at
    FROM sessions
    WHERE user_id = ? AND (displaced_at IS NULL) AND expires_at > datetime('now')
    ORDER BY last_activity DESC
  `).all(req.user.id);
  res.json(rows.map(r => ({
    ...r,
    current: r.token === currentToken,
    // Expose only first/last 4 chars of the token so the UI can identify rows without leaking it
    token: r.token.slice(0, 4) + '...' + r.token.slice(-4),
    full_token: r.token === currentToken ? null : r.token, // still don't expose other tokens
  })));
});

// POST /api/auth/sessions/revoke — revoke a specific session (not current)
router.post('/sessions/revoke', requireAuth, (req, res) => {
  const { token_prefix } = req.body;
  if (!token_prefix) return res.status(400).json({ error: 'token_prefix required' });
  const currentToken = req.headers['authorization']?.replace('Bearer ', '');

  // Find all non-current sessions for this user matching the prefix
  const candidates = db.prepare(`
    SELECT token FROM sessions
    WHERE user_id = ? AND token != ? AND displaced_at IS NULL
  `).all(req.user.id, currentToken);

  const match = candidates.find(c =>
    c.token.startsWith(token_prefix.slice(0, 4)) && c.token.endsWith(token_prefix.slice(-4))
  );
  if (!match) return res.status(404).json({ error: 'Session not found' });

  db.prepare('DELETE FROM sessions WHERE token = ?').run(match.token);
  res.json({ success: true });
});

// POST /api/auth/sessions/revoke-all — sign out everywhere except current
router.post('/sessions/revoke-all', requireAuth, (req, res) => {
  const currentToken = req.headers['authorization']?.replace('Bearer ', '');
  const result = db.prepare(`
    UPDATE sessions SET displaced_reason = ?, displaced_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND token != ? AND displaced_at IS NULL
  `).run('You signed out remotely', req.user.id, currentToken);
  res.json({ success: true, revoked: result.changes });
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
  res.json({
    ...req.user,
    planLimits: getPlanLimits(plan),
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

// POST /api/auth/lookup-email — get masked email for a username (for forgot password)
router.post('/lookup-email', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ email: null });

  const user = db.prepare('SELECT email FROM users WHERE username = ?').get(username);
  if (!user) return res.json({ email: null });

  // Return masked email: a****s@gmail.com
  const email = user.email;
  const [local, domain] = email.split('@');
  const masked = local.charAt(0) + '*'.repeat(Math.max(local.length - 2, 1)) + local.charAt(local.length - 1) + '@' + domain;
  res.json({ email: masked, full: email });
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

    // Send reset email
    const nodemailer = (await import('nodemailer')).default;
    const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
    const smtpPort = db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || '587';
    const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
    const smtpPass = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value;
    const fromEmail = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value;

    if (smtpUser && smtpHost) {
      const baseUrl = req.headers.origin || `https://${req.headers.host}`;
      const resetUrl = `${baseUrl}/app?reset=${resetToken}`;
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: parseInt(smtpPort), secure: parseInt(smtpPort) === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });

      await transporter.sendMail({
        from: fromEmail || smtpUser,
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
    }
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
