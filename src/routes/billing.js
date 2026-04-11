import { Router } from 'express';
import Stripe from 'stripe';
import db from '../db/index.js';
import { hashPassword, generateToken } from '../middleware/auth.js';

const router = Router();

function getStripe() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
  const key = row?.value || process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe not configured. Add stripe_secret_key in Settings.');
  return new Stripe(key);
}

// Plan config
const PLANS = {
  starter: {
    name: 'Starter',
    price_myr: 99,
    trial_days: 14,
    features: '100 leads, 3 campaigns, 50 AI actions/mo',
  },
  pro: {
    name: 'Pro',
    price_myr: 199,
    trial_days: 14,
    features: '500 leads, 10 campaigns, 200 AI actions/mo, auto-outreach',
  },
  business: {
    name: 'Business',
    price_myr: 399,
    trial_days: 14,
    features: 'Unlimited leads & campaigns, 1000 AI actions/mo, team accounts',
  },
};

// GET /api/billing/plans — public, returns plan info
router.get('/plans', (req, res) => {
  res.json(PLANS);
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

    // Create checkout session with trial
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

    // Generate random password and create account
    const tempPassword = Math.random().toString(36).slice(-10);
    const hash = hashPassword(tempPassword);

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + (PLANS[plan]?.trial_days || 14));

    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, display_name, plan, budget_limit, monthly_system_cost, status)
      VALUES (?, ?, ?, 'user', ?, ?, 0, ?, 'active')
    `).run(
      username, email, hash, displayName || username, plan,
      PLANS[plan]?.price_myr || 99
    );

    // Store Stripe customer and subscription IDs
    const userId = result.lastInsertRowid;
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

    // Send welcome email with credentials
    try {
      const nodemailer = (await import('nodemailer')).default;
      const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
      const smtpPort = db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || '587';
      const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
      const smtpPass = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value;
      const fromEmail = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value;

      if (smtpUser && smtpHost) {
        const transporter = nodemailer.createTransport({
          host: smtpHost, port: parseInt(smtpPort), secure: parseInt(smtpPort) === 465,
          auth: { user: smtpUser, pass: smtpPass },
        });
        const baseUrl = req.headers.origin || `https://${req.headers.host}`;
        await transporter.sendMail({
          from: fromEmail || smtpUser,
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
              <p>Your 14-day free trial starts today. You won't be charged until the trial ends.</p>
              <hr style="margin:24px 0">
              <p style="color:#999;font-size:12px">EIAAW SalesAgent AI — AI-Human Sales Partnerships<br>
              <a href="https://eiaawsolutions.com">eiaawsolutions.com</a></p>
            </div>
          `,
        });
      }
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    }

    // Redirect to app with auto-login token (password sent via email, not URL)
    res.redirect(`/app?welcome=1&token=${token}&tempPassword=${encodeURIComponent(tempPassword)}`);
  } catch (err) {
    console.error('Billing success error:', err);
    res.redirect('/?error=setup_failed');
  }
});

// POST /api/billing/webhook — Stripe webhook for subscription events
router.post('/webhook', async (req, res) => {
  // Handle subscription updates, cancellations, payment failures
  try {
    const event = req.body;

    switch (event.type) {
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
