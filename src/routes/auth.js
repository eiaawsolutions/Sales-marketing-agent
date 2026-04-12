import { Router } from 'express';
import db from '../db/index.js';
import { hashPassword, verifyPassword, generateToken, requireAuth, getPlanLimits } from '../middleware/auth.js';

const router = Router();

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

  // Auto-upgrade legacy SHA256 hash to bcrypt
  if (passResult === 'upgrade') {
    const newHash = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  }

  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  }

  // Create session (24h expiry)
  const token = generateToken();
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+24 hours'))"
  ).run(token, user.id);

  // Clean expired sessions
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

  const plan = user.plan || 'starter';

  res.json({
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
    },
  });
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
