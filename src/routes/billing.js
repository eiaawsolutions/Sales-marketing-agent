import { Router } from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import db from '../db/index.js';
import { hashPassword, generateToken, getPlanLimits, requireAuth } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';
import { sendEmail } from '../utils/email.js';

const router = Router();

// CSPRNG password / verify-code generators. Math.random() is not a CSPRNG —
// the 36-char base alphabet has only ~36 possible output classes per char
// from a predictable seed, so adjacent values are guessable.
const PWD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomFromAlphabet(alphabet, len) {
  const N = alphabet.length;
  const safe = 256 - (256 % N);
  const out = [];
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      if (buf[i] < safe) out.push(alphabet[buf[i] % N]);
    }
  }
  return out.join('');
}
const randomTempPassword = () => randomFromAlphabet(PWD_ALPHABET, 12);
const randomVerifyCode = () => randomFromAlphabet(CODE_ALPHABET, 8);

function getStripe() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
  const key = row?.value ? decrypt(row.value) : process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe not configured. Add stripe_secret_key in Settings.');
  return new Stripe(key);
}

// Plan config
// Lead caps reflect real web-search economics (~RM 0.95 per verified lead).
const PLANS = {
  starter: {
    name: 'Starter',
    price_myr: 99,
    trial_days: 14,
    features: '30 AI-verified leads/mo · 3 campaigns · 50 AI actions/mo · 5 voice calls/mo',
  },
  pro: {
    name: 'Pro',
    price_myr: 199,
    trial_days: 14,
    features: '70 AI-verified leads/mo · 10 campaigns · 200 AI actions/mo · 20 voice calls/mo · auto-outreach · AI lead gen',
  },
  business: {
    name: 'Business',
    price_myr: 399,
    trial_days: 14,
    features: '140 AI-verified leads/mo · 25 campaigns · 1,000 AI actions/mo · 100 voice calls/mo · priority Sonnet · up to 10 seats',
  },
};

// GET /api/billing/plans — public, returns plan info
router.get('/plans', (req, res) => {
  res.json(PLANS);
});

// Contact reveal add-on packs
const REVEAL_ADDONS = {
  reveal_20:  { name: '20 Extra Reveals',  credits: 20,  price_myr: 19 },
  reveal_50:  { name: '50 Extra Reveals',  credits: 50,  price_myr: 39 },
  reveal_100: { name: '100 Extra Reveals', credits: 100, price_myr: 69 },
};

// AI credit add-on packs (extra AI actions on top of plan limit)
const AI_CREDIT_ADDONS = {
  ai_50:  { name: '50 Extra AI Actions',  credits: 50,  price_myr: 29 },
  ai_100: { name: '100 Extra AI Actions', credits: 100, price_myr: 49 },
  ai_500: { name: '500 Extra AI Actions', credits: 500, price_myr: 149 },
};

// GET /api/billing/usage — current user's usage vs plan limits
router.get('/usage', requireAuth, (req, res) => {
  const userId = req.user.id;
  const plan = req.user.plan || 'starter';
  const limits = getPlanLimits(plan);

  const leads = db.prepare('SELECT COUNT(*) as c FROM leads WHERE user_id = ?').get(userId).c;
  const campaigns = db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE user_id = ?').get(userId).c;
  const aiActions = db.prepare(
    "SELECT COUNT(*) as c FROM ai_cost_log WHERE user_id = ? AND created_at >= datetime('now', 'start of month')"
  ).get(userId).c;
  const contactReveals = db.prepare(
    "SELECT COUNT(*) as c FROM activities WHERE user_id = ? AND description LIKE 'Contact revealed:%' AND created_at >= datetime('now', 'start of month')"
  ).get(userId).c;

  const addonCredits = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`reveal_addon_${userId}`)?.value || '0');
  const aiAddonCredits = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai_addon_${userId}`)?.value || '0');

  const trialEnd = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`trial_end_${userId}`)?.value;
  const isTrialing = trialEnd && new Date(trialEnd) > new Date();

  res.json({
    plan,
    planName: PLANS[plan]?.name || plan,
    price: PLANS[plan]?.price_myr || 0,
    isTrialing,
    trialEnd: trialEnd || null,
    usage: { leads, campaigns, aiActions, contactReveals },
    limits: {
      leads: limits.leads,
      campaigns: limits.campaigns,
      aiActions: limits.ai_actions,
      aiActionsAddon: aiAddonCredits,
      aiActionsTotal: limits.ai_actions + aiAddonCredits,
      contactReveals: limits.contact_reveals,
      contactRevealsAddon: addonCredits,
      contactRevealsTotal: limits.contact_reveals + addonCredits,
      autoOutreach: limits.auto_outreach,
      autoLeads: limits.auto_leads,
      chatbot: limits.chatbot,
    },
    allPlans: PLANS,
    revealAddons: REVEAL_ADDONS,
    aiCreditAddons: AI_CREDIT_ADDONS,
    stripeConfigured: !!db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get()?.value,
  });
});

// POST /api/billing/buy-reveals — purchase extra contact reveal credits
router.post('/buy-reveals', requireAuth, async (req, res) => {
  try {
    const { pack } = req.body;
    if (!pack || !REVEAL_ADDONS[pack]) return res.status(400).json({ error: 'Invalid add-on pack.' });

    const addon = REVEAL_ADDONS[pack];
    const userId = req.user.id;

    const stripe = getStripe();
    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const customerId = db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_customer_${userId}`)?.value;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      ...(customerId ? { customer: customerId } : { customer_email: req.user.email }),
      line_items: [{
        price_data: {
          currency: 'myr',
          product_data: { name: `EIAAW SalesAgent — ${addon.name}` },
          unit_amount: addon.price_myr * 100,
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/api/billing/reveal-success?userId=${userId}&pack=${pack}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/app?page=billing`,
      metadata: { type: 'reveal_addon', pack, userId: String(userId), credits: String(addon.credits) },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/reveal-success — grant credits after Stripe payment
router.get('/reveal-success', async (req, res) => {
  try {
    const { userId, pack, session_id } = req.query;
    const addon = REVEAL_ADDONS[pack];
    if (!addon || !userId) return res.redirect('/app?page=billing&error=invalid');

    // Verify payment
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.redirect('/app?page=billing&error=payment_failed');

    // Grant credits (idempotent check via session metadata)
    const granted = db.prepare("SELECT value FROM settings WHERE key = ?").get(`reveal_granted_${session_id}`);
    if (!granted) {
      const current = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`reveal_addon_${userId}`)?.value || '0');
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .run(`reveal_addon_${userId}`, String(current + addon.credits));
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .run(`reveal_granted_${session_id}`, 'true');
    }

    res.redirect('/app?page=billing&addon=success');
  } catch (err) {
    res.redirect('/app?page=billing&error=setup_failed');
  }
});

// POST /api/billing/buy-ai-credits — purchase extra AI action credits
router.post('/buy-ai-credits', requireAuth, async (req, res) => {
  try {
    const { pack } = req.body;
    if (!pack || !AI_CREDIT_ADDONS[pack]) return res.status(400).json({ error: 'Invalid AI credit pack.' });

    const addon = AI_CREDIT_ADDONS[pack];
    const userId = req.user.id;

    const stripe = getStripe();
    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const customerId = db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_customer_${userId}`)?.value;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      ...(customerId ? { customer: customerId } : { customer_email: req.user.email }),
      line_items: [{
        price_data: {
          currency: 'myr',
          product_data: { name: `EIAAW SalesAgent — ${addon.name}` },
          unit_amount: addon.price_myr * 100,
        },
        quantity: 1,
      }],
      success_url: `${baseUrl}/api/billing/ai-credit-success?userId=${userId}&pack=${pack}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/app?page=billing`,
      metadata: { type: 'ai_credit_addon', pack, userId: String(userId), credits: String(addon.credits) },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/ai-credit-success — grant AI credits after Stripe payment
router.get('/ai-credit-success', async (req, res) => {
  try {
    const { userId, pack, session_id } = req.query;
    const addon = AI_CREDIT_ADDONS[pack];
    if (!addon || !userId) return res.redirect('/app?page=billing&error=invalid');

    // Verify payment
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.redirect('/app?page=billing&error=payment_failed');

    // Grant credits (idempotent check via session metadata)
    const granted = db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai_credit_granted_${session_id}`);
    if (!granted) {
      const current = parseInt(db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai_addon_${userId}`)?.value || '0');
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .run(`ai_addon_${userId}`, String(current + addon.credits));
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .run(`ai_credit_granted_${session_id}`, 'true');
    }

    res.redirect('/app?page=billing&addon=ai_success');
  } catch (err) {
    res.redirect('/app?page=billing&error=setup_failed');
  }
});

// POST /api/billing/upgrade — upgrade plan via Stripe checkout
router.post('/upgrade', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan.' });

    const currentPlan = req.user.plan || 'starter';
    const planOrder = { starter: 0, pro: 1, business: 2 };
    if (planOrder[plan] <= planOrder[currentPlan]) {
      return res.status(400).json({ error: 'You are already on this plan or higher.' });
    }

    const stripe = getStripe();
    const userId = req.user.id;

    // Get or create Stripe price for target plan
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_price_${plan}`);
    let priceId = row?.value;

    if (!priceId) {
      const product = await stripe.products.create({
        name: `EIAAW SalesAgent - ${PLANS[plan].name}`,
        description: PLANS[plan].features,
      });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: PLANS[plan].price_myr * 100,
        currency: 'myr',
        recurring: { interval: 'month' },
      });
      priceId = price.id;
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .run(`stripe_price_${plan}`, priceId);
    }

    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const customerId = db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_customer_${userId}`)?.value;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(customerId ? { customer: customerId } : { customer_email: req.user.email }),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/app?upgraded=${plan}`,
      cancel_url: `${baseUrl}/app?page=billing`,
      metadata: { plan, userId: String(userId), upgrade: 'true' },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/checkout — create Stripe checkout session for signup
router.post('/checkout', async (req, res) => {
  try {
    const { plan, email, username, displayName } = req.body;

    if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan. Choose starter, pro, or business.' });
    if (!email || !username) return res.status(400).json({ error: 'Email and username required.' });

    // Check if username/email already exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) return res.status(400).json({ error: 'Username or email already exists. Please login instead.' });

    const stripe = getStripe();
    const planInfo = PLANS[plan];

    // Get or create Stripe price
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`stripe_price_${plan}`);
    let priceId = row?.value;

    if (!priceId) {
      // Create product and price in Stripe
      const product = await stripe.products.create({
        name: `EIAAW SalesAgent - ${planInfo.name}`,
        description: planInfo.features,
      });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: planInfo.price_myr * 100, // cents
        currency: 'myr',
        recurring: { interval: 'month' },
      });
      priceId = price.id;
      // Save for reuse
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .run(`stripe_price_${plan}`, priceId);
    }

    // Create checkout session with trial.
    // allow_promotion_codes lets the customer enter coupon codes (e.g.
    // FOUNDER_HQ for the founder comp) on the Stripe-hosted checkout page.
    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      subscription_data: {
        trial_period_days: planInfo.trial_days,
        metadata: { plan, username, displayName: displayName || username },
      },
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${baseUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/#pricing`,
      metadata: { plan, username, email, displayName: displayName || username },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/success — handle successful checkout, create account
router.get('/success', async (req, res) => {
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id, {
      expand: ['subscription'],
    });

    if (session.payment_status !== 'paid' && !session.subscription?.trial_start) {
      return res.redirect('/?error=payment_failed');
    }

    const { plan, username, email, displayName } = session.metadata;

    // Check if already created (idempotent)
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      // Already exists, just redirect to login
      return res.redirect('/app?signup=exists');
    }

    // CSPRNG temp password — Math.random was previously seeded predictably.
    const tempPassword = randomTempPassword();
    const hash = hashPassword(tempPassword);

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + (PLANS[plan]?.trial_days || 14));

    // CSPRNG verification code (no ambiguous chars).
    const verifyCode = randomVerifyCode();

    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, display_name, plan, budget_limit, monthly_system_cost, status, email_verified)
      VALUES (?, ?, ?, 'user', ?, ?, 0, ?, 'active', 0)
    `).run(
      username, email, hash, displayName || username, plan,
      PLANS[plan]?.price_myr || 99
    );

    // Store Stripe customer and subscription IDs
    const userId = result.lastInsertRowid;

    // Store verification code
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`verify_code_${userId}`, verifyCode);
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`stripe_customer_${userId}`, session.customer);
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`stripe_subscription_${userId}`, session.subscription?.id || '');
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`trial_end_${userId}`, trialEnd.toISOString());

    // Auto-login: create session
    const token = generateToken();
    db.prepare(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+24 hours'))"
    ).run(token, userId);

    // Welcome + login details. Goes through sendEmail() so it uses the same
    // Resend → SMTP fallback as outreach mail; the previous hand-rolled SMTP
    // path read smtp_pass without decrypting it (smtp_pass is in
    // SENSITIVE_KEYS) and silently failed.
    try {
      const baseUrl = req.headers.origin || `https://${req.headers.host}`;
      await sendEmail({
        to: email,
        subject: 'Welcome to EIAAW SalesAgent — Your Login Details',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
            <h1 style="color:#2ec4b6">Welcome to EIAAW SalesAgent!</h1>
            <p>Hi ${displayName || username},</p>
            <p>Your account is ready. Here are your login details:</p>
            <div style="background:#f5f5f5;padding:20px;border-radius:8px;margin:20px 0">
              <p><strong>Login URL:</strong> <a href="${baseUrl}/app">${baseUrl}/app</a></p>
              <p><strong>Username:</strong> ${username}</p>
              <p><strong>Password:</strong> ${tempPassword}</p>
              <p><strong>Plan:</strong> ${PLANS[plan]?.name || plan} (14-day free trial)</p>
            </div>
            <p style="color:#e74c3c"><strong>Please change your password after your first login.</strong></p>
            <p style="background:#fff3cd;padding:12px;border-radius:6px;margin-top:12px"><strong>Verify your email:</strong> Enter code <strong style="font-size:18px;letter-spacing:2px">${verifyCode}</strong> in the app to activate full features.</p>
            <p>Your 14-day free trial starts today. You won't be charged until the trial ends.</p>
            <hr style="margin:24px 0">
            <p style="color:#999;font-size:12px">EIAAW SalesAgent AI — AI-Human Sales Partnerships<br>
            <a href="https://eiaawsolutions.com">eiaawsolutions.com</a></p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    }

    // Store temp password for one-time retrieval (NOT in URL)
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`temp_pass_${token}`, tempPassword);

    // The session token used to ride along in the URL (?token=...), which
    // leaks via referrer headers, browser history, and any analytics that
    // capture URLs. Move it to an httpOnly + Secure + SameSite=Lax cookie
    // that the SPA reads via a one-time GET /api/billing/welcome-token
    // exchange. The URL only carries the welcome flag, no secret.
    res.cookie('eiaaw_welcome', token, {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000, // 5 minutes — enough for the redirect + first GET
      path: '/',
    });
    res.redirect('/app?welcome=1');
  } catch (err) {
    console.error('Billing success error:', err);
    res.redirect('/?error=setup_failed');
  }
});

// GET /api/billing/welcome-token — one-time exchange of the cookie for the
// real session token + temp password. The cookie is cleared on the way out
// so a forwarded link / replayed cookie cannot re-fetch the secrets.
router.get('/welcome-token', (req, res) => {
  const token = req.cookies?.eiaaw_welcome;
  if (!token) return res.status(404).json({ error: 'No welcome token' });
  // Always clear the cookie — replay protection.
  res.clearCookie('eiaaw_welcome', { path: '/' });
  const session = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?").get(token);
  if (!session) return res.status(404).json({ error: 'Welcome session expired' });
  const tempRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(`temp_pass_${token}`);
  // Burn the temp-pass row too so the password can be retrieved exactly once.
  db.prepare("DELETE FROM settings WHERE key = ?").run(`temp_pass_${token}`);
  res.json({ token, tempPassword: tempRow?.value || null });
});

// POST /api/billing/webhook — Stripe webhook for subscription events.
// `req.body` is a raw Buffer here (see the express.raw mount in server.js for
// this exact path). Signature verification is MANDATORY: refusing to verify
// when the secret is unset is the only safe default, otherwise an
// unauthenticated attacker can POST a synthetic checkout.session.completed and
// upgrade any user's plan.
router.post('/webhook', async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const sig = req.headers['stripe-signature'];
    const webhookSecret = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'stripe_webhook_secret'").get()?.value)
      || process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('[stripe-webhook] Refusing request: STRIPE_WEBHOOK_SECRET is not configured. Set it in Settings or env before exposing this endpoint.');
      return res.status(503).json({ error: 'Webhook signing secret not configured' });
    }
    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    let event;
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (sigErr) {
      console.error('[stripe-webhook] Signature verification failed:', sigErr.message);
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Handle upgrade checkout completion
        if (session.metadata?.upgrade === 'true' && session.metadata?.userId) {
          const plan = session.metadata.plan;
          const userId = session.metadata.userId;
          db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, userId);
          // Update Stripe refs
          if (session.customer) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
              .run(`stripe_customer_${userId}`, session.customer);
          }
          if (session.subscription) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
              .run(`stripe_subscription_${userId}`, session.subscription);
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // Find user by subscription ID and suspend
        const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'stripe_subscription_%'").all();
        for (const row of rows) {
          if (row.value === sub.id) {
            const usrId = row.key.replace('stripe_subscription_', '');
            db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(usrId);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(usrId);
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        // Could suspend or warn user
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
