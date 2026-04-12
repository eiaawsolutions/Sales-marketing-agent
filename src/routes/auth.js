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
