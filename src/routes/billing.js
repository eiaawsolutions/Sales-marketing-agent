import { Router } from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import db from '../db/index.js';
import { hashPassword, generateToken, getPlanLimits, requireAuth } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';
import { sendEmail } from '../utils/email.js';
import { isFounderHq } from '../config/hq.js';

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

// Reverse-lookup the local user id from a Stripe subscription id. Subscription
// ids are stored in settings keyed by user id (stripe_subscription_<userId>),
// so we scan that key space. Returns the userId string, or null if unmatched.
function userIdForSubscription(subId) {
  if (!subId) return null;
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'stripe_subscription_%'").all();
  for (const row of rows) {
    if (row.value === subId) return row.key.replace('stripe_subscription_', '');
  }
  return null;
}

// Plan config
// Lead caps reflect real web-search economics (~RM 0.95 per verified lead).
//
// trial_days = 0 on every plan: signups are charged when Stripe Checkout
// completes. A trial meant EIAAW absorbed the web-search + Anthropic cost of
// every non-converter for 14 days. The key is kept (rather than deleted) so a
// trial can be re-enabled per-plan by setting it > 0 — checkout, the success
// handler, and the welcome email all branch on it.
const PLANS = {
  starter: {
    name: 'Starter',
    price_myr: 99,
    trial_days: 0,
    features: '30 AI-verified leads/mo · 3 campaigns · 50 AI actions/mo · 5 voice calls/mo',
  },
  pro: {
    name: 'Pro',
    price_myr: 199,
    trial_days: 0,
    features: '70 AI-verified leads/mo · 10 campaigns · 200 AI actions/mo · 20 voice calls/mo · auto-outreach · AI lead gen',
  },
  business: {
    name: 'Business',
    price_myr: 399,
    trial_days: 0,
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

  // Pending cancellation: set by the customer.subscription.updated webhook when
  // the user schedules cancellation in the portal. Value is the effective ISO
  // date (or 'true' if the date was unavailable). Cleared on reinstate/delete.
  const cancelPendingRaw = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`cancel_pending_${userId}`)?.value;
  const cancelAt = cancelPendingRaw && cancelPendingRaw !== 'true' ? cancelPendingRaw : null;

  // HQ / Founder comp — scoped to the single FOUNDER_HQ_EMAIL account, NOT to
  // every superadmin. That one account is a business-tier subscriber whose
  // invoices are RM 0.00 via the FOUNDER_HQ 100%-off Stripe coupon (see
  // scripts/apply-founder-coupon.js and the founder-token branch of /checkout).
  // Mirrors SMT's model where the founder rides a real tier but is comped.
  // `comped` is advisory — the true RM 0.00 lives on the Stripe subscription
  // discount — so the billing UI can render "Business — comped (Founder)"
  // instead of a price. We force the plan label to Business because HQ is always
  // provisioned there (promote-founder + schema.js). A second superadmin is NOT
  // comped: they fall through to the normal paid-subscriber billing view.
  const comped = isFounderHq(req.user.email);
  const compReason = comped ? 'Founder' : null;
  const effectivePlan = comped ? 'business' : plan;
  // Whether a Stripe customer exists for this account. Only a founder-checkout
  // HQ has one; a hand-promoted admin may not. The UI gates the "Manage
  // subscription" button on this so it never opens the portal for an account
  // that would 400 (no stripe_customer_ row).
  const hasStripeCustomer = !!db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_customer_${userId}`)?.value;

  res.json({
    plan: effectivePlan,
    planName: PLANS[effectivePlan]?.name || effectivePlan,
    price: comped ? 0 : (PLANS[plan]?.price_myr || 0),
    comped,
    compReason,
    stripeCustomer: hasStripeCustomer,
    isTrialing,
    trialEnd: trialEnd || null,
    cancelPending: !!cancelPendingRaw,
    cancelAt,
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

// Ensure a Billing Portal configuration exists with self-serve cancellation
// enabled, and return its id. We create + cache the config rather than relying
// on the account's default portal config being toggled on in the Dashboard —
// this makes cancellation self-healing: if the default config is ever missing
// or reset, the first /portal call recreates a working one. The config id is
// cached in settings so we don't hit the configurations API on every request.
async function ensurePortalConfig(stripe, baseUrl) {
  const cached = db.prepare("SELECT value FROM settings WHERE key = 'stripe_portal_config'").get()?.value;
  if (cached) {
    // Verify it still exists and is active; if Stripe 404s or it's archived,
    // fall through and recreate.
    try {
      const existing = await stripe.billingPortal.configurations.retrieve(cached);
      if (existing && existing.active !== false) return existing.id;
    } catch (_) { /* recreate below */ }
  }

  const config = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: 'EIAAW SalesAgent — manage your subscription',
      privacy_policy_url: `${baseUrl}/privacy.html`,
      terms_of_service_url: `${baseUrl}/terms.html`,
    },
    features: {
      // Self-serve cancellation. `at_period_end` means the user keeps access
      // until the current paid period ends, matching the Terms:
      // "cancellation takes effect at the end of the current cycle."
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other'],
        },
      },
      // Let users update their card and view past invoices without contacting us.
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
  });

  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run('stripe_portal_config', config.id);
  return config.id;
}

// POST /api/billing/portal — open the Stripe Customer Portal so the user can
// cancel, update their card, or view invoices. Self-serve cancellation is the
// primary use: the subscription renews monthly and this is the path to stop it
// (effective end-of-cycle). The Stripe customer id is resolved server-side from
// the authenticated user, so a user can only ever manage their own
// subscription (no IDOR).
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const customerId = db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_customer_${userId}`)?.value;
    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found. If you signed up with a special offer or have not completed checkout, contact support to manage your subscription.' });
    }

    const stripe = getStripe();
    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const configuration = await ensurePortalConfig(stripe, baseUrl);

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration,
      return_url: `${baseUrl}/app?page=billing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/checkout — create Stripe checkout session for signup
router.post('/checkout', async (req, res) => {
  try {
    const { plan, email, username, displayName, founderToken } = req.body;

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

    // Founder comp: if the request carries a valid founderToken matching
    // FOUNDER_TOKEN env, server-side attach the FOUNDER_HQ coupon to the
    // checkout. This is mutually exclusive with allow_promotion_codes per
    // Stripe API, so we branch.
    const founderTokenEnv = process.env.FOUNDER_TOKEN || '';
    const isFounderSignup = founderToken
      && founderTokenEnv.length >= 32
      && Buffer.from(founderToken).length === Buffer.from(founderTokenEnv).length
      && crypto.timingSafeEqual(Buffer.from(founderToken), Buffer.from(founderTokenEnv));

    const baseUrl = req.headers.origin || `https://${req.headers.host}`;

    // No trial by default (PLANS[*].trial_days === 0) — the card is charged when
    // Checkout completes. Stripe rejects trial_period_days: 0, so only send the
    // key when a plan genuinely carries a trial.
    const subscriptionData = {
      metadata: { plan, username, displayName: displayName || username },
    };
    if (planInfo.trial_days > 0) {
      subscriptionData.trial_period_days = planInfo.trial_days;
    }

    const checkoutPayload = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      subscription_data: subscriptionData,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/#pricing`,
      metadata: { plan, username, email, displayName: displayName || username },
    };

    if (isFounderSignup) {
      checkoutPayload.discounts = [{ coupon: 'FOUNDER_HQ' }];
      checkoutPayload.metadata.founder = '1';
      checkoutPayload.subscription_data.metadata.founder = '1';
    } else {
      checkoutPayload.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(checkoutPayload);

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A checkout session may legitimately provision an account in three states:
//   'paid'                → the card was charged (the normal, no-trial path)
//   'no_payment_required' → nothing was due at completion. Two ways to get
//                           here: the 100%-off FOUNDER_HQ coupon, or a trial
//                           (Stripe does not charge on completion, so it never
//                           reports 'paid'). Gating on 'paid' alone would
//                           reject every comped account.
//   subscription trialing → belt-and-braces for the trial case.
export function isProvisionable(session) {
  return ['paid', 'no_payment_required'].includes(session.payment_status)
    || session.subscription?.status === 'trialing';
}

// Create the account for a completed signup checkout. Idempotent, and shared by
// BOTH entry points:
//   1. GET /success — the browser redirect after Stripe Checkout
//   2. the checkout.session.completed webhook — the safety net for a customer
//      who paid but never reached (1): tab closed, network dropped, or the
//      redirect 500'd. With no trial the card is charged AT checkout, so
//      without this net that customer is billed and has no account.
//
// Returns { status: 'created' | 'exists' | 'skipped', userId?, token? }.
// The unique indexes on users.email / users.username make the insert the real
// arbiter when the redirect and the webhook race each other — whoever loses the
// race catches the constraint error and reports 'exists' rather than
// double-provisioning.
export async function provisionFromSession(session, baseUrl) {
  const md = session.metadata || {};

  // Upgrades of existing accounts are handled by the webhook's own branch, and
  // a session with no plan/username isn't a signup at all.
  if (md.upgrade === 'true') return { status: 'skipped' };
  const { plan, username, email, displayName } = md;
  if (!plan || !username || !email || !PLANS[plan]) return { status: 'skipped' };

  const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) return { status: 'exists', userId: existing.id };

  // CSPRNG temp password — Math.random was previously seeded predictably.
  const tempPassword = randomTempPassword();
  const hash = hashPassword(tempPassword);
  const trialDays = PLANS[plan].trial_days || 0;
  // CSPRNG verification code (no ambiguous chars).
  const verifyCode = randomVerifyCode();

  // Auto-login session. The webhook path never uses this token (there is no
  // browser to hand it to); it is harmless and expires in 24h.
  const token = generateToken();

  // All-or-nothing. A half-written account is the worst outcome now that the
  // card is charged before we get here: the retrying webhook would see the user
  // row, report 'exists', and never write the missing stripe_customer_* row —
  // leaving a paying customer who cannot open the billing portal.
  const createAccount = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, display_name, plan, budget_limit, monthly_system_cost, status, email_verified)
      VALUES (?, ?, ?, 'user', ?, ?, 0, ?, 'active', 0)
    `).run(username, email, hash, displayName || username, plan, PLANS[plan].price_myr);
    const uid = result.lastInsertRowid;

    const put = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)");
    put.run(`verify_code_${uid}`, verifyCode);
    put.run(`stripe_customer_${uid}`, session.customer);
    put.run(`stripe_subscription_${uid}`, session.subscription?.id || '');

    // Only stamp a trial marker when the plan actually granted one. GET /usage
    // derives isTrialing from this key, so its absence is what makes a new
    // signup render as an ordinary paid subscription. Accounts created while
    // trials were live keep their existing marker and finish their trial.
    if (trialDays > 0) {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + trialDays);
      put.run(`trial_end_${uid}`, trialEnd.toISOString());
    }

    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+24 hours'))")
      .run(token, uid);
    // Store temp password for one-time retrieval (NOT in URL)
    put.run(`temp_pass_${token}`, tempPassword);

    return uid;
  });

  let userId;
  try {
    userId = createAccount();
  } catch (e) {
    // The other entry point won the race between our SELECT and this INSERT.
    // The transaction rolled back, so there is nothing to clean up.
    if (/UNIQUE constraint/i.test(e.message)) {
      const winner = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
      if (winner) return { status: 'exists', userId: winner.id };
    }
    throw e;
  }

  // Welcome + login details. Goes through sendEmail() so it uses the same
  // Resend → SMTP fallback as outreach mail; the previous hand-rolled SMTP
  // path read smtp_pass without decrypting it (smtp_pass is in
  // SENSITIVE_KEYS) and silently failed. When the webhook is the one that
  // provisions, this email is the customer's ONLY route to their credentials.
  try {
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
            <p><strong>Plan:</strong> ${PLANS[plan].name}${trialDays > 0 ? ` (${trialDays}-day free trial)` : ` — RM ${PLANS[plan].price_myr}/month`}</p>
          </div>
          <p style="color:#e74c3c"><strong>Please change your password after your first login.</strong></p>
          <p style="background:#fff3cd;padding:12px;border-radius:6px;margin-top:12px"><strong>Verify your email:</strong> Enter code <strong style="font-size:18px;letter-spacing:2px">${verifyCode}</strong> in the app to activate full features.</p>
          <p>${trialDays > 0
            ? `Your ${trialDays}-day free trial starts today. You won't be charged until the trial ends.`
            : `Your subscription is active from today and renews monthly. You can cancel anytime from <strong>Plan &amp; Billing</strong> — access continues to the end of the cycle you've paid for.`}</p>
          <hr style="margin:24px 0">
          <p style="color:#999;font-size:12px">EIAAW SalesAgent AI — AI-Human Sales Partnerships<br>
          <a href="https://eiaawsolutions.com">eiaawsolutions.com</a></p>
        </div>
      `,
    });
  } catch (emailErr) {
    console.error('Welcome email failed:', emailErr.message);
  }

  return { status: 'created', userId, token };
}

// GET /api/billing/success — handle successful checkout, create account
router.get('/success', async (req, res) => {
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id, {
      expand: ['subscription'],
    });

    if (!isProvisionable(session)) {
      return res.redirect('/?error=payment_failed');
    }

    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const result = await provisionFromSession(session, baseUrl);

    if (result.status !== 'created') {
      // Already provisioned (webhook won the race, or this redirect was
      // replayed), or the session wasn't a signup. Send them to login.
      return res.redirect('/app?signup=exists');
    }

    const token = result.token;

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
          break;
        }

        // SIGNUP SAFETY NET. The card is charged when Checkout completes, so a
        // customer who never lands on /success (tab closed, network drop,
        // redirect error) would otherwise be billed with no account. Re-fetch
        // the session to get the expanded subscription the webhook payload
        // omits, then run the SAME idempotent provisioner /success uses — if
        // the redirect already won, this no-ops on the email-exists guard.
        // Throwing here returns 400 and Stripe retries, which is what we want.
        if (session.metadata?.plan && session.metadata?.username) {
          const stripe = getStripe();
          const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription'] });
          if (isProvisionable(full)) {
            const result = await provisionFromSession(full, `https://${req.headers.host}`);
            if (result.status === 'created') {
              console.warn(`[stripe-webhook] RECOVERED stranded signup — provisioned user ${result.userId} for session ${session.id} that /success never finished.`);
            }
          } else {
            console.info(`[stripe-webhook] signup session ${session.id} payment_status=${full.payment_status} — not provisioning.`);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        // Fired when a user schedules cancellation in the Customer Portal
        // (cancel_at_period_end -> true), or reverses it ("Renew plan" ->
        // false). The subscription is still ACTIVE here — access continues
        // until the period ends — so we only record a "pending cancellation"
        // marker for the UI; we do NOT suspend. customer.subscription.deleted
        // (Step 2, end of period) is what actually suspends.
        const sub = event.data.object;
        const usrId = userIdForSubscription(sub.id);
        if (usrId) {
          if (sub.cancel_at_period_end) {
            // cancel_at is the unix timestamp the cancellation takes effect.
            // Fall back to current_period_end, which in flexible billing mode
            // lives on the subscription ITEM (sub.items.data[0]) rather than
            // the subscription root, then to the root for legacy shapes.
            const effective = sub.cancel_at
              || sub.items?.data?.[0]?.current_period_end
              || sub.current_period_end;
            const iso = effective ? new Date(effective * 1000).toISOString() : '';
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
              .run(`cancel_pending_${usrId}`, iso || 'true');
          } else {
            // Reinstated — clear the pending marker.
            db.prepare("DELETE FROM settings WHERE key = ?").run(`cancel_pending_${usrId}`);
          }
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // Find user by subscription ID and suspend. This is the real
        // end-of-period cancellation (or an immediate cancel).
        const usrId = userIdForSubscription(sub.id);
        if (usrId) {
          // Never suspend the single HQ / Founder account. It rides a Business
          // subscription comped to RM 0.00 by the FOUNDER_HQ coupon; if that
          // subscription is ever deleted (coupon rotated, Stripe housekeeping),
          // HQ must keep full access — losing the operator account is far worse
          // than a lapsed comp. Scoped to FOUNDER_HQ_EMAIL only (not every
          // superadmin), matching the /usage comp scope. Clear the pending
          // marker but leave status/sessions untouched.
          const usr = db.prepare('SELECT email FROM users WHERE id = ?').get(usrId);
          if (isFounderHq(usr?.email)) {
            db.prepare("DELETE FROM settings WHERE key = ?").run(`cancel_pending_${usrId}`);
            console.warn(`[stripe-webhook] subscription.deleted for HQ Founder account ${usrId} — NOT suspending (Founder comp).`);
          } else {
            db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(usrId);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(usrId);
            // Cancellation is now complete — the pending marker is obsolete.
            db.prepare("DELETE FROM settings WHERE key = ?").run(`cancel_pending_${usrId}`);
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
