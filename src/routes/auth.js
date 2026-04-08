import { Router } from 'express';
import db from '../db/index.js';
import { hashPassword, generateToken, requireAuth } from '../middleware/auth.js';

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

  const hash = hashPassword(password);
  if (hash !== user.password_hash) {
    return res.status(401).json({ error: 'Invalid username or password' });
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

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      displayName: user.display_name,
      budgetLimit: user.budget_limit,
      monthlySystemCost: user.monthly_system_cost,
    },
  });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

export default router;
