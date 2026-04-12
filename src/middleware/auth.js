import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';

const BCRYPT_ROUNDS = 10;

export function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password, hash) {
  // Support both bcrypt and legacy SHA256 hashes (auto-upgrade)
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
    return bcrypt.compareSync(password, hash);
  }
  // Legacy SHA256 — check and signal upgrade needed
  const sha256 = crypto.createHash('sha256').update(password).digest('hex');
  if (sha256 === hash) {
    return 'upgrade'; // Signal to upgrade hash
  }
  return false;
}

export function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Core auth middleware
export function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.username, u.email, u.role,
           u.display_name, u.budget_limit, u.monthly_system_cost,
           u.status as user_status, u.plan
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);

  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // Idle timeout — 30 minutes of inactivity
  if (session.last_activity) {
    const lastActive = new Date(session.last_activity + 'Z').getTime();
    const now = Date.now();
    const idleMinutes = (now - lastActive) / 60000;
    if (idleMinutes > 30) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
    }
  }

  // Update last activity
  db.prepare("UPDATE sessions SET last_activity = datetime('now') WHERE token = ?").run(token);

  if (session.user_status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  }

  // Get email verification status
  const userRow = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(session.user_id);

  req.user = {
    id: session.user_id,
    username: session.username,
    email: session.email,
    role: session.role,
    plan: session.plan || 'starter',
    displayName: session.display_name,
    budgetLimit: session.budget_limit,
    monthlySystemCost: session.monthly_system_cost,
    emailVerified: !!(userRow?.email_verified),
  };

  next();
}

export function requireSuperadmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required' });
  }
  next();
}

// Plan limits
const PLAN_LIMITS = {
  starter: { leads: 100, campaigns: 3, ai_actions: 50, model: 'claude-haiku-4-5-20251001', users: 1, auto_outreach: false, auto_leads: false },
  pro:     { leads: 500, campaigns: 10, ai_actions: 200, model: 'claude-sonnet-4-20250514', users: 3, auto_outreach: true, auto_leads: true },
  business:{ leads: 99999, campaigns: 99999, ai_actions: 1000, model: 'claude-sonnet-4-20250514', users: 10, auto_outreach: true, auto_leads: true },
};

export function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.starter;
}

// Check if user is within plan limits for a resource
export function checkPlanLimit(req, resource) {
  if (req.user.role === 'superadmin') return true;

  const limits = getPlanLimits(req.user.plan);
  const userId = req.user.id;

  switch (resource) {
    case 'leads': {
      const count = db.prepare('SELECT COUNT(*) as c FROM leads WHERE user_id = ?').get(userId);
      if (count.c >= limits.leads) {
        throw new Error(`Lead limit reached (${limits.leads} on ${req.user.plan} plan). Upgrade for more.`);
      }
      return true;
    }
    case 'campaigns': {
      const count = db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE user_id = ?').get(userId);
      if (count.c >= limits.campaigns) {
        throw new Error(`Campaign limit reached (${limits.campaigns} on ${req.user.plan} plan). Upgrade for more.`);
      }
      return true;
    }
    case 'ai_action': {
      // Count AI actions this month
      const count = db.prepare(
        "SELECT COUNT(*) as c FROM ai_cost_log WHERE user_id = ? AND created_at >= datetime('now', 'start of month')"
      ).get(userId);
      if (count.c >= limits.ai_actions) {
        throw new Error(`AI action limit reached (${limits.ai_actions}/month on ${req.user.plan} plan). Upgrade for more.`);
      }
      return true;
    }
    case 'auto_outreach': {
      if (!limits.auto_outreach) {
        throw new Error('Auto-outreach is available on Pro and Business plans. Upgrade to unlock.');
      }
      return true;
    }
    case 'auto_leads': {
      if (!limits.auto_leads) {
        throw new Error('Auto-lead generation is available on Pro and Business plans. Upgrade to unlock.');
      }
      return true;
    }
  }
  return true;
}
