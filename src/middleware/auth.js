import crypto from 'crypto';
import db from '../db/index.js';

export function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Core auth middleware - attaches req.user or rejects
export function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.username, u.email, u.role,
           u.display_name, u.budget_limit, u.monthly_system_cost, u.status as user_status
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);

  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  if (session.user_status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  }

  req.user = {
    id: session.user_id,
    username: session.username,
    email: session.email,
    role: session.role,
    displayName: session.display_name,
    budgetLimit: session.budget_limit,
    monthlySystemCost: session.monthly_system_cost,
  };

  next();
}

// Superadmin-only middleware (use after requireAuth)
export function requireSuperadmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}
