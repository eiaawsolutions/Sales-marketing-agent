import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/index.js';
import { getPlanLimits, hashPassword, generateToken, requireAccountOwner } from '../middleware/auth.js';
import { sendEmail } from '../utils/email.js';
import { getProfile } from '../services/account-profile.js';
import { normalizeEmail } from '../utils/normalize.js';

// Seats. The account owner invites teammates up to the plan's seat count
// (Starter 1, Pro 3, Business 10 — the owner counts as one). A teammate gets
// their own login and works in the owner's account. Mounted with requireAuth
// only (not actAsAccount): everything here is keyed on req.user.accountId.
const router = Router();
const INVITE_VALID_MS = 7 * 24 * 60 * 60 * 1000;

function members(accountId) {
  return db.prepare(`SELECT id, username, email, display_name, created_at FROM users WHERE account_owner_id = ? ORDER BY created_at`).all(accountId);
}

function seats(accountId, plan) {
  return { seats_used: 1 + members(accountId).length, seats_limit: getPlanLimits(plan).users };
}

function newUsername(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 20) || 'member';
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}${crypto.randomInt(100, 10000)}`;
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) return candidate;
  }
  return `${base}${crypto.randomBytes(4).toString('hex')}`;
}

function htmlText(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

router.get('/', (req, res) => {
  const owner = db.prepare('SELECT id, username, email, display_name FROM users WHERE id = ?').get(req.user.accountId);
  res.json({
    is_owner: !req.user.isMember,
    owner: { name: owner?.display_name || owner?.username, email: owner?.email },
    members: members(req.user.accountId).map(m => ({ id: m.id, name: m.display_name || m.username, username: m.username, email: m.email, joined: m.created_at })),
    ...seats(req.user.accountId, req.user.plan),
  });
});

router.post('/invite', requireAccountOwner, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').replace(/[\r\n<>]/g, ' ').trim().slice(0, 80);
    if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });

    const { seats_used, seats_limit } = seats(req.user.accountId, req.user.plan);
    if (seats_used >= seats_limit) {
      return res.status(403).json({ error: `Your ${req.user.plan} plan includes ${seats_limit} seat${seats_limit === 1 ? '' : 's'} (you included). Remove a teammate or upgrade to add more.` });
    }
    if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email)) {
      return res.status(409).json({ error: 'That address can’t be invited. If they already have a SalesAgent login, ask them for a different work email.' });
    }

    const username = newUsername(email);
    // An unusable random password until they set their own from the link.
    const userId = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, display_name, status, plan, email_verified, account_owner_id)
      VALUES (?, ?, ?, 'user', ?, 'active', ?, 1, ?)
    `).run(username, email, hashPassword(crypto.randomBytes(32).toString('hex')), name || null, req.user.plan, req.user.accountId).lastInsertRowid;

    // Same token store as forgot-password, so the existing "set a new
    // password" screen (/app?reset=…) completes the invite.
    const token = generateToken();
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run(`reset_token_${token}`, JSON.stringify({ userId, expires: Date.now() + INVITE_VALID_MS }));

    const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value || 'https://sa.eiaawsolutions.com';
    const business = getProfile(req.user.accountId).business_name || req.user.displayName || req.user.username;
    const inviter = req.user.displayName || req.user.username;
    await sendEmail({
      to: email,
      subject: `${inviter} invited you to ${business} on EIAAW SalesAgent`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px;font-size:15px;line-height:1.6;color:#1a1a1a">
          <p>Hi ${htmlText(name || 'there')},</p>
          <p>${htmlText(inviter)} added you to <strong>${htmlText(business)}</strong>'s SalesAgent workspace, where outreach is reviewed and approved before it goes out.</p>
          <p>Your username is <strong>${htmlText(username)}</strong>. Set your password to get started:</p>
          <p><a href="${baseUrl}/app?reset=${token}" style="background:#11766A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Set my password</a></p>
          <p style="color:#666;font-size:13px">The link works for 7 days. If you weren't expecting this, you can ignore it.</p>
        </div>`,
    });

    res.json({ ok: true, member: { id: userId, username, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:memberId', requireAccountOwner, (req, res) => {
  const member = db.prepare('SELECT id FROM users WHERE id = ? AND account_owner_id = ?').get(req.params.memberId, req.user.accountId);
  if (!member) return res.status(404).json({ error: 'Teammate not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(member.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
  })();
  res.json({ ok: true });
});

export default router;
