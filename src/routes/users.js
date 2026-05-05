import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth, requireSuperadmin, hashPassword } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireSuperadmin);

// GET /api/users — list all users with usage stats
router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.display_name, u.budget_limit,
           u.monthly_system_cost, u.status, u.created_at, u.updated_at,
      (SELECT COUNT(*) FROM leads WHERE user_id = u.id) as lead_count,
      (SELECT COUNT(*) FROM campaigns WHERE user_id = u.id) as campaign_count,
      (SELECT COUNT(*) FROM pipeline WHERE user_id = u.id) as deal_count,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_cost_log WHERE user_id = u.id) as ai_spend,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM ai_cost_log WHERE user_id = u.id) as total_tokens
    FROM users u ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// POST /api/users — DISABLED.
// All accounts MUST go through Stripe Checkout (POST /api/billing/checkout →
// /api/billing/success). Direct creation bypasses billing, leaves no Stripe
// customer/subscription record, and breaks the verification-first signup
// contract. Comp accounts: issue a 100% Stripe coupon and have the user run
// the public signup flow with it.
router.post('/', (req, res) => {
  return res.status(410).json({
    error: 'Direct account creation is disabled. All accounts must sign up via Stripe Checkout at /#pricing. For comp accounts, issue a 100% off Stripe coupon.',
  });
});

// GET /api/users/:id — user detail
router.get('/:id', (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.display_name, u.budget_limit,
           u.monthly_system_cost, u.status, u.created_at, u.updated_at,
      (SELECT COUNT(*) FROM leads WHERE user_id = u.id) as lead_count,
      (SELECT COUNT(*) FROM campaigns WHERE user_id = u.id) as campaign_count,
      (SELECT COUNT(*) FROM pipeline WHERE user_id = u.id) as deal_count,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_cost_log WHERE user_id = u.id) as ai_spend,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM ai_cost_log WHERE user_id = u.id) as total_tokens
    FROM users u WHERE u.id = ?
  `).get(req.params.id);

  if (!user) return res.status(404).json({ error: 'User not found' });

  // Get their campaigns with costs
  const campaigns = db.prepare(`
    SELECT c.*, COALESCE(SUM(a.cost_usd), 0) as ai_cost
    FROM campaigns c LEFT JOIN ai_cost_log a ON a.campaign_id = c.id
    WHERE c.user_id = ? GROUP BY c.id ORDER BY c.created_at DESC
  `).all(req.params.id);

  res.json({ ...user, campaigns });
});

// PUT /api/users/:id — update user
router.put('/:id', (req, res) => {
  const { username, display_name, email, role, budget_limit, monthly_system_cost, status, plan } = req.body;
  const fields = [];
  const params = [];

  if (username !== undefined) { fields.push('username = ?'); params.push(username); }
  if (display_name !== undefined) { fields.push('display_name = ?'); params.push(display_name); }
  if (email !== undefined) { fields.push('email = ?'); params.push(email); }
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (plan !== undefined) { fields.push('plan = ?'); params.push(plan); }
  if (budget_limit !== undefined) { fields.push('budget_limit = ?'); params.push(parseFloat(budget_limit) || 0); }
  if (monthly_system_cost !== undefined) { fields.push('monthly_system_cost = ?'); params.push(parseFloat(monthly_system_cost) || 0); }
  if (status !== undefined) { fields.push('status = ?'); params.push(status); }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  try {
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    // If suspended, kill their sessions
    if (status === 'suspended') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
    }

    const user = db.prepare('SELECT id, username, email, role, display_name, budget_limit, monthly_system_cost, status FROM users WHERE id = ?').get(req.params.id);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/users/:id/password — reset password
router.put('/:id/password', (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const hash = hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  res.json({ success: true });
});

// DELETE /api/users/:id — delete user and all their data
router.delete('/:id', (req, res) => {
  const userId = parseInt(req.params.id);

  // Don't allow deleting yourself
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Delete all user data in correct order
  db.transaction(() => {
    db.prepare('DELETE FROM outreach_queue WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM campaign_leads WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM ai_cost_log WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM agent_tasks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM generated_content WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM activities WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM pipeline WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM campaigns WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM leads WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();

  res.json({ success: true });
});

export default router;
