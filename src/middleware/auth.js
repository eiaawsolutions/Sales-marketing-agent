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

  // Session displacement — kicked by a newer login elsewhere
  if (session.displaced_at) {
    const reason = session.displaced_reason || 'Your account was signed in from another device';
    // Clean up the displaced session so it can't linger
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: reason, code: 'session_displaced' });
  }

  // Idle timeout — 30 minutes of inactivity
  try {
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
  } catch (e) {
    // Column may not exist yet on older DBs — skip idle timeout gracefully
  }

  if (session.user_status === 'suspended') {
    return res.status(403).json({ error: 'Account suspended. Contact your administrator.' });
  }

  // Get email verification + MFA status (columns may not exist on older DBs)
  let userRow;
  try { userRow = db.prepare('SELECT email_verified, mfa_enabled FROM users WHERE id = ?').get(session.user_id); } catch (e) { userRow = null; }

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
    mfaEnabled: !!(userRow?.mfa_enabled),
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
// `leads` = lifetime cap on manually-created leads (historical).
// `ai_leads_per_month` = monthly cap on AI-generated verified leads (new, tied to web-search cost).
const PLAN_LIMITS = {
  starter:    { leads: 100,   campaigns: 3,     ai_actions: 50,   ai_leads_per_month: 30,   contact_reveals: 10,  model: 'claude-haiku-4-5-20251001',   users: 1,  auto_outreach: false, auto_leads: false, voice_calls: 5,   chatbot: false },
  pro:        { leads: 500,   campaigns: 10,    ai_actions: 200,  ai_leads_per_month: 70,   contact_reveals: 50,  model: 'claude-sonnet-4-20250514',    users: 3,  auto_outreach: true,  auto_leads: true,  voice_calls: 20,  chatbot: true  },
  business:   { leads: 99999, campaigns: 25,    ai_actions: 1000, ai_leads_per_month: 140,  contact_reveals: 200, model: 'claude-sonnet-4-20250514',    users: 10, auto_outreach: true,  auto_leads: true,  voice_calls: 100, chatbot: true  },
  enterprise: { leads: 99999, campaigns: 99999, ai_actions: 99999,ai_leads_per_month: 99999,contact_reveals: 9999,model: 'claude-sonnet-4-20250514',    users: 9999,auto_outreach: true, auto_leads: true,  voice_calls: 9999,chatbot: true  },
};

// Voice AI add-on pricing
export const VOICE_ADDONS = {
  voice_starter: { name: 'Voice Starter', calls: 50, price_myr: 49, per_min: 0.50 },
  voice_pro: { name: 'Voice Pro', calls: 200, price_myr: 149, per_min: 0.40 },
  voice_unlimited: { name: 'Voice Unlimited', calls: 1000, price_myr: 399, per_min: 0.30 },
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
    case 'active_campaigns': {
      // Cap on simultaneously-running campaigns. Reuses the `campaigns` plan limit
      // but only counts campaigns currently consuming automation (active/scheduled).
      // Paused/stopped/completed/draft do not count.
      const count = db.prepare(
        "SELECT COUNT(*) as c FROM campaigns WHERE user_id = ? AND status IN ('active','scheduled')"
      ).get(userId);
      if (count.c >= limits.campaigns) {
        throw new Error(`Active-campaign limit reached (${limits.campaigns} running on ${req.user.plan} plan). Pause or stop one before activating another, or upgrade.`);
      }
      return true;
    }
    case 'ai_action': {
      // Count AI actions this month
      const count = db.prepare(
        "SELECT COUNT(*) as c FROM ai_cost_log WHERE user_id = ? AND created_at >= datetime('now', 'start of month')"
      ).get(userId);
      // Check plan limit + any purchased add-on credits
      const aiAddonCredits = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai_addon_${userId}`)?.value || '0');
      const totalAiLimit = limits.ai_actions + aiAddonCredits;
      if (count.c >= totalAiLimit) {
        throw new Error(`AI action limit reached (${totalAiLimit}/month on ${req.user.plan} plan${aiAddonCredits > 0 ? ` + ${aiAddonCredits} add-on` : ''}). ${aiAddonCredits > 0 ? 'Buy more credits or upgrade' : 'Add more credits or upgrade'} from Plan & Billing.`);
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
    case 'ai_leads_per_month': {
      // Counts verified AI-generated leads this calendar month. Starter gets 30,
      // Pro 70, Business 140, Enterprise effectively unlimited. Driven by the
      // real web-search cost of ~RM 0.95 per verified lead.
      const count = db.prepare(
        "SELECT COUNT(*) as c FROM leads WHERE user_id = ? AND source = 'ai_generated' AND created_at >= datetime('now', 'start of month')"
      ).get(userId);
      if (count.c >= limits.ai_leads_per_month) {
        throw new Error(`AI lead generation limit reached (${limits.ai_leads_per_month}/month on ${req.user.plan} plan). Upgrade for a higher cap.`);
      }
      return true;
    }
    case 'contact_reveal': {
      const count = db.prepare(
        "SELECT COUNT(*) as c FROM activities WHERE user_id = ? AND description LIKE 'Contact revealed:%' AND created_at >= datetime('now', 'start of month')"
      ).get(userId);
      // Check plan limit + any add-on credits
      const addonCredits = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`reveal_addon_${userId}`)?.value || '0');
      const totalLimit = limits.contact_reveals + addonCredits;
      if (count.c >= totalLimit) {
        throw new Error(`Contact reveal limit reached (${totalLimit}/month on ${req.user.plan} plan). Add more credits from Plan & Billing.`);
      }
      return true;
    }
    case 'voice_call': {
      const voiceCount = db.prepare(
        "SELECT COUNT(*) as c FROM activities WHERE user_id = ? AND type = 'voice_call' AND created_at >= datetime('now', 'start of month')"
      ).get(userId);
      const voiceAddonCredits = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`voice_addon_${userId}`)?.value || '0');
      const totalVoiceLimit = limits.voice_calls + voiceAddonCredits;
      if (voiceCount.c >= totalVoiceLimit) {
        throw new Error(`Voice call limit reached (${totalVoiceLimit}/month on ${req.user.plan} plan${voiceAddonCredits > 0 ? ` + ${voiceAddonCredits} add-on` : ''}). Add more credits or upgrade from Plan & Billing.`);
      }
      return true;
    }
  }
  return true;
}
