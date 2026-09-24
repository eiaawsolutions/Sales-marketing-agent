import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { FOUNDER_HQ_EMAIL, isFounderHq } from './config/hq.js';

import db from './db/index.js';
import { requireAuth } from './middleware/auth.js';
import { decrypt } from './utils/crypto.js';
import { sendEmail } from './utils/email.js';
import authRouter from './routes/auth.js';
import billingRouter from './routes/billing.js';
import usersRouter from './routes/users.js';
import leadsRouter from './routes/leads.js';
import campaignsRouter from './routes/campaigns.js';
import pipelineRouter from './routes/pipeline.js';
import agentRouter from './routes/agent.js';
import settingsRouter from './routes/settings.js';
import systemLogicRouter from './routes/system-logic.js';
import voiceRouter from './routes/voice.js';
import appointmentsRouter from './routes/appointments.js';
import trackingRouter from './routes/tracking.js';
import uploadsRouter from './routes/uploads.js';
import formsRouter, { saveInboundLead, normaliseSite } from './routes/forms.js';
import ingestRouter from './routes/ingest.js';
import sourcesRouter from './routes/sources.js';
import segmentsRouter from './routes/segments.js';
import { maskLeads, maskLead } from './services/leads.js';
import { startScheduler } from './services/scheduler.js';
import { SALES_AGENT_PROMPT } from './routes/voice.js';
import { buildChatbotPrompt } from './prompts/chatbot.js';
import { getParentFacts } from './services/site-facts.js';
import { GIT_SHA, BUILT_AT } from './version.js';

// Fingerprint of the voice prompt that /refresh-prompt-with-token pushes to
// Retell. Computed once at boot — the prompt is a module-level constant.
// promptSha lets the deploy pipeline assert "the build I'm about to refresh
// carries the exact prompt I expect", which length alone can't guarantee.
const PROMPT_SHA = crypto.createHash('sha256').update(SALES_AGENT_PROMPT).digest('hex').slice(0, 16);
const PROMPT_CHARS = SALES_AGENT_PROMPT.length;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://cdn.jsdelivr.net", "https://esm.sh", "https://connect.facebook.net"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://checkout.stripe.com", "https://api.stripe.com", "wss://*.retellai.com", "https://*.retellai.com", "wss://*.livekit.cloud", "https://*.livekit.cloud", "https://esm.sh", "https://www.facebook.com", "https://connect.facebook.net"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["https://js.stripe.com", "https://checkout.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Allow social-media + AI-engine crawlers to fetch og:image and other public assets
  // from a different origin (Twitter cards, Facebook, LinkedIn, Slack, etc.).
  // Default `same-origin` would 403 cross-origin scrapers fetching /media/*.jpg.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://sa.eiaawsolutions.com', 'https://eiaawsolutions.com', 'https://www.eiaawsolutions.com', 'https://ep.eiaawsolutions.com', 'https://ads.eiaawsolutions.com', 'https://smt.eiaawsolutions.com', 'https://sales-marketing-agent-production.up.railway.app', 'http://localhost:3000'],
  credentials: true,
}));

// Stripe webhook MUST receive the raw body — Stripe signs the byte stream and
// `JSON.stringify(req.body)` after a JSON parse re-orders keys / changes
// whitespace, breaking signature verification. Mount the raw body parser ONLY
// for the webhook path, before the global express.json() so every other route
// still gets the parsed body.
app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }));

// Same reasoning for the omnichannel lead-ingest endpoint. Every inbound
// connector (our own HMAC, Calendly, Cal.com, Resend/Svix) signs the exact bytes
// it sent. express.json() parses and discards them, and JSON.stringify(req.body)
// does not reproduce the original — key order, whitespace, and \u escaping all
// differ — so a signature computed over the re-serialised body fails at random.
// `type: '*/*'` because Google Ads posts application/json but Zapier and Make
// can be configured to send text/plain or an unset Content-Type; the route
// parses the buffer itself and rejects anything that is not a JSON object.
app.use('/api/ingest', express.raw({ type: '*/*', limit: '512kb' }));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Protect proposal.html — admin only (redirect to landing if not authenticated)
app.get('/proposal.html', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.redirect('/');
  const session = db.prepare("SELECT s.*, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token);
  if (!session || session.role !== 'superadmin') return res.redirect('/');
  next();
});

// One URL per page: the landing file is the homepage, and extensionless legal
// URLs resolve instead of falling through to the 404 below.
app.get(['/landing.html', '/index.html'], (req, res) => res.redirect(301, '/'));
app.get(['/privacy', '/terms', '/security'], (req, res) => res.redirect(301, `${req.path}.html`));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  etag: true,
  // Correct MIME types for SEO/AI-discovery files. express.static defaults are
  // mostly fine but `.webmanifest` and the LLM/AI text files need explicit types
  // so crawlers and PWA installers don't reject them.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    } else if (filePath.endsWith('llms.txt') || filePath.endsWith('llms-full.txt') || filePath.endsWith('ai.txt') || filePath.endsWith('humans.txt') || filePath.endsWith('robots.txt') || filePath.endsWith('security.txt')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      // Encourage caching with revalidation
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    } else if (filePath.endsWith('sitemap.xml')) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    }
  },
}));

// Trust proxy for Railway/reverse proxy
app.set('trust proxy', 1);

// CSRF protection — double-submit cookie pattern for SPA
app.use((req, res, next) => {
  // Skip for GET/HEAD/OPTIONS and public routes
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/auth/login') || req.path.startsWith('/api/auth/lookup') || req.path.startsWith('/api/auth/forgot') || req.path.startsWith('/api/auth/reset-password-with-token') || req.path.startsWith('/api/billing/webhook') || req.path.startsWith('/api/billing/checkout') || req.path.startsWith('/api/contact') || req.path.startsWith('/api/voice/webhook') || req.path.startsWith('/api/voice/tool-callback') || req.path.startsWith('/api/voice/call-link-token') || req.path.startsWith('/api/voice/public-session') || req.path.startsWith('/api/voice/refresh-prompt-with-token') || req.path.startsWith('/api/tracking/') || req.path.startsWith('/api/forms/public/') || req.path.startsWith('/api/ingest/') || req.path.startsWith('/api/_internal/')) return next();

  // For authenticated requests, Bearer token in Authorization header provides CSRF protection
  // because third-party sites cannot set custom headers in cross-origin requests
  const hasAuthHeader = req.headers['authorization']?.startsWith('Bearer ');
  if (hasAuthHeader) return next();

  // For unauthenticated POST requests (checkout, etc.), check origin
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  const envAllowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allowed = envAllowed.length ? envAllowed : ['https://sa.eiaawsolutions.com', 'https://eiaawsolutions.com', 'https://www.eiaawsolutions.com', 'https://ep.eiaawsolutions.com', 'https://ads.eiaawsolutions.com', 'https://smt.eiaawsolutions.com', 'https://sales-marketing-agent-production.up.railway.app', 'http://localhost:3000'];
  if (allowed.some(a => origin.startsWith(a))) return next();

  return res.status(403).json({ error: 'Request blocked — invalid origin.' });
});

// Rate limiting (validate:false to avoid IPv6 errors on Railway)
//
// /api/ingest is exempted from the global per-IP cap and limited per ingest_key
// inside routes/ingest.js instead. Google Ads and Calendly deliver from large
// shared IP ranges, so a 120/min per-IP cap would drop one tenant's leads
// because a different tenant's provider happened to burst from the same egress
// node. Unknown keys still hit a per-IP guessing limiter in that router.
app.use('/api', rateLimit({
  windowMs: 60000, max: 120, message: { error: 'Too many requests. Please slow down.' }, validate: false,
  skip: (req) => req.originalUrl.startsWith('/api/ingest/'),
}));
app.use('/api/auth/login', rateLimit({ windowMs: 900000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' }, validate: false }));
// Username enumeration + email-flood prevention: per-IP cap on the unauthenticated
// account-discovery endpoints. Pair with the in-route 60-second per-user throttle
// already in /resend-verification and /forgot-password.
app.use('/api/auth/lookup-email', rateLimit({ windowMs: 900000, max: 20, message: { error: 'Too many lookups. Try again later.' }, validate: false }));
app.use('/api/auth/forgot-password', rateLimit({ windowMs: 900000, max: 5, message: { error: 'Too many password-reset requests. Try again later.' }, validate: false }));
// Per-user AI rate limiting
app.use('/api/agent', rateLimit({
  windowMs: 60000, max: 10, validate: false,
  keyGenerator: (req) => {
    try {
      const token = req.headers['authorization']?.replace('Bearer ', '');
      if (token) {
        const session = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
        if (session) return `ai_user_${session.user_id}`;
      }
    } catch (e) { /* fallback to IP */ }
    return req.ip || 'unknown';
  },
  message: { error: 'AI rate limit reached (10/min per user). Wait a moment.' },
}));
app.use('/api/campaigns/*/send', rateLimit({ windowMs: 60000, max: 3, message: { error: 'Send rate limit — max 3 per minute.' }, validate: false }));
// Paid-action endpoints: every Retell voice call costs ~$0.50, every Stripe
// checkout-session creation hits a paid API. Tight per-IP caps add a brake
// on top of the per-plan voice/checkout limits already enforced in-route.
app.use(['/api/voice/web-call', '/api/voice/call', '/api/voice/auto-call', '/api/voice/generate-link'],
  rateLimit({ windowMs: 60000, max: 5, message: { error: 'Voice call rate limit — max 5 per minute per IP.' }, validate: false }));
app.use('/api/voice/public-session',
  rateLimit({ windowMs: 60000, max: 3, message: { error: 'Too many call sessions. Wait a moment.' }, validate: false }));
app.use(['/api/billing/checkout', '/api/billing/upgrade-checkout', '/api/billing/buy-reveals', '/api/billing/buy-ai-credits'],
  rateLimit({ windowMs: 60000, max: 6, message: { error: 'Checkout rate limit — slow down.' }, validate: false }));

// Health check (no auth)
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      // Build identity — lets the deploy pipeline confirm the new code is
      // actually live before running /refresh-prompt-with-token.
      gitSha: GIT_SHA,
      builtAt: BUILT_AT,
      // Voice-prompt fingerprint — this is the exact SALES_AGENT_PROMPT that
      // the refresh endpoint pushes to Retell. Assert these match what you
      // expect before refreshing, so you never push a stale/old prompt.
      promptChars: PROMPT_CHARS,
      promptSha: PROMPT_SHA,
    });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

// One-shot production purge — wipes ALL user-scoped data so the DB starts
// fresh with Stripe Checkout as the only account-creation path.
//
// Activation: requires BOTH (1) a PURGE_TOKEN env var on the server (long
// random string) AND (2) the same value passed in the X-Purge-Token request
// header. After the purge runs once, unset PURGE_TOKEN and redeploy so the
// route returns 404 again.
//
// IRREVERSIBLE. Authorized by founder 2026-05-06.
app.post('/api/_internal/purge-and-reset', (req, res) => {
  const expected = process.env.PURGE_TOKEN || '';
  const received = req.headers['x-purge-token'] || '';
  if (!expected || expected.length < 32) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Constant-time compare so a timing oracle can't leak the token char-by-char.
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(404).json({ error: 'Not found' });
  }

  // FK-safe topological order. Children before parents:
  //   form_submissions → forms → users
  //   sessions, ai_cost_log, outreach_queue, campaign_leads, activities,
  //   generated_content, appointments, pipeline → campaigns/leads/users
  //   campaigns, leads, agent_tasks, users have no outbound FKs
  const userTables = [
    'form_submissions',
    'forms',
    'sessions',
    'ai_cost_log',
    'generated_content',
    'outreach_queue',
    'campaign_leads',
    'appointments',
    'activities',
    'pipeline',
    'campaigns',
    'leads',
    'agent_tasks',
    'users',
  ];
  const userScopedSettingsLike = [
    'stripe_customer_%', 'stripe_subscription_%', 'verify_code_%',
    'temp_pass_%', 'trial_end_%', 'reveal_addon_%', 'reveal_granted_%',
    'ai_addon_%', 'ai_credit_granted_%',
  ];

  const counts = { before: {}, deleted: {}, settings_keys_deleted: 0 };
  for (const t of userTables) {
    try { counts.before[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch (_) { counts.before[t] = 'missing'; }
  }

  const tx = db.transaction(() => {
    for (const t of userTables) {
      try {
        const r = db.prepare(`DELETE FROM ${t}`).run();
        counts.deleted[t] = r.changes;
      } catch (e) {
        counts.deleted[t] = `error: ${e.message}`;
        throw e;
      }
    }
    for (const t of userTables) {
      try { db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(t); } catch (_) {}
    }
    for (const pat of userScopedSettingsLike) {
      const r = db.prepare('DELETE FROM settings WHERE key LIKE ?').run(pat);
      counts.settings_keys_deleted += r.changes;
    }
  });

  try {
    tx();
    console.log('[purge-and-reset] EXECUTED:', JSON.stringify(counts));
    res.json({
      ok: true,
      message: 'Purge complete. Now: (1) unset PURGE_TOKEN env, (2) redeploy, (3) sign up via /#pricing with FOUNDER_HQ coupon.',
      counts,
    });
  } catch (e) {
    console.error('[purge-and-reset] FAILED:', e.message);
    res.status(500).json({ ok: false, error: e.message, counts });
  }
});

// One-shot Stripe coupon creator — creates FOUNDER_HQ (100% off, forever)
// using the Stripe key from settings or env. Same token gate. Idempotent:
// returns the existing coupon if it already exists.
app.post('/api/_internal/create-founder-coupon', express.json(), async (req, res) => {
  const expected = process.env.PURGE_TOKEN || '';
  const received = req.headers['x-purge-token'] || '';
  if (!expected || expected.length < 32) return res.status(404).json({ error: 'Not found' });
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const Stripe = (await import('stripe')).default;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
    const key = row?.value ? decrypt(row.value) : process.env.STRIPE_SECRET_KEY;
    if (!key) return res.status(500).json({ error: 'No Stripe key configured' });
    const stripe = new Stripe(key);
    const COUPON_ID = 'FOUNDER_HQ';

    let coupon;
    try {
      coupon = await stripe.coupons.retrieve(COUPON_ID);
    } catch (e) {
      if (e.code !== 'resource_missing') throw e;
    }
    // If coupon doesn't exist yet, fall through to creation block below.
    // If coupon exists, we still want to ensure the matching promo code
    // exists, so DON'T early-return here.

    if (!coupon) {
      coupon = await stripe.coupons.create({
        id: COUPON_ID,
        name: 'EIAAW Founder Comp',
        percent_off: 100,
        duration: 'forever',
        metadata: {
          purpose: 'founder',
          authorized_by: 'amos',
          created_at: new Date().toISOString(),
        },
      });
    }

    // Also create a promotion code for the same coupon — Stripe Checkout's
    // "allow_promotion_codes" UI accepts promotion code IDs (human-readable
    // text), not raw coupon IDs. Without this, the customer literally
    // cannot type FOUNDER_HQ in the checkout box.
    let promo;
    let promoError;
    try {
      const existingPromo = await stripe.promotionCodes.list({ code: COUPON_ID, limit: 1 });
      if (existingPromo.data.length) {
        promo = existingPromo.data[0];
      } else {
        // Use raw fetch — the SDK helper has been flaky on this call.
        const params = new URLSearchParams();
        params.append('coupon', COUPON_ID);
        params.append('code', COUPON_ID);
        params.append('active', 'true');
        params.append('metadata[purpose]', 'founder');
        const r = await fetch('https://api.stripe.com/v1/promotion_codes', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
        if (!r.ok) {
          throw new Error(`Stripe ${r.status}: ${body.error?.message || text}`);
        }
        promo = body;
      }
    } catch (e) {
      promoError = e.message;
      console.error('[create-founder-coupon] promo code creation failed:', e.message);
    }

    res.json({
      ok: true,
      message: promo ? 'FOUNDER_HQ coupon + promo code created' : 'Coupon created but promo code failed — see promoError',
      coupon,
      promo: promo || null,
      promoError: promoError || null,
    });
  } catch (err) {
    console.error('[create-founder-coupon] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Read-only probe — returns row counts without modifying anything. Use this
// instead of /api/_internal/purge-and-reset to check state.
app.get('/api/_internal/state', (req, res) => {
  const expected = process.env.PURGE_TOKEN || '';
  const received = req.headers['x-purge-token'] || '';
  if (!expected || expected.length < 32) return res.status(404).json({ error: 'Not found' });
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const tables = ['users', 'sessions', 'leads', 'campaigns', 'pipeline', 'forms', 'form_submissions', 'activities', 'appointments', 'ai_cost_log', 'agent_tasks', 'generated_content', 'outreach_queue', 'campaign_leads'];
  const counts = {};
  for (const t of tables) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch (_) { counts[t] = 'missing'; }
  }
  const users = db.prepare('SELECT id, username, email, role, plan, status, email_verified, created_at FROM users').all();
  res.json({ counts, users });
});

// One-shot founder unlock + password reset + magic-login token.
// Token-gated. Clears the account-lockout counter, optionally resets the
// password, and ALWAYS issues a fresh 24h session token returned in the
// response so the founder can log in without typing the password.
//
// Body: { email, newPassword? }
app.post('/api/_internal/founder-reset', express.json(), async (req, res) => {
  const expected = process.env.PURGE_TOKEN || '';
  const received = req.headers['x-purge-token'] || '';
  if (!expected || expected.length < 32) return res.status(404).json({ error: 'Not found' });
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const email = (req.body?.email || '').toLowerCase().trim();
  const newPassword = req.body?.newPassword || '';
  if (!email) {
    return res.status(400).json({ error: 'email required' });
  }
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: `No user with email ${email}` });
  const { hashPassword, generateToken } = await import('./middleware/auth.js');

  let passwordReset = false;
  if (newPassword && newPassword.length >= 8) {
    const hash = hashPassword(newPassword);
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(hash, user.id);
    passwordReset = true;
  }
  // Always clear lockout counters and old sessions.
  db.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?`).run(user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

  // Issue a fresh 24h session — the magic link.
  const sessionToken = generateToken();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+24 hours'))").run(sessionToken, user.id);

  console.log(`[founder-reset] User ${email} (id=${user.id}) reset; session ${sessionToken.slice(0, 8)}...`);
  res.json({
    ok: true,
    message: passwordReset ? `Password reset and magic-session issued for ${email}` : `Magic-session issued for ${email} (password unchanged)`,
    userId: user.id,
    sessionToken,
    magicLink: `https://sa.eiaawsolutions.com/app?welcome=1&token=${sessionToken}`,
  });
});

// One-shot founder promotion — promote the freshly-signed-up account to
// superadmin. Same token-gated pattern as the purge route. Also sets
// email_verified=1 so the founder skips the email-verify step.
//
// Body: { email: "eiaawsolutions@gmail.com" }
app.post('/api/_internal/promote-founder', express.json(), (req, res) => {
  const expected = process.env.PURGE_TOKEN || '';
  const received = req.headers['x-purge-token'] || '';
  if (!expected || expected.length < 32) return res.status(404).json({ error: 'Not found' });
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  // Invariant: only the HQ / Founder account may be a superadmin. Even a valid
  // PURGE_TOKEN cannot promote any other address.
  if (!isFounderHq(email)) {
    return res.status(403).json({ error: `Only the HQ account (${FOUNDER_HQ_EMAIL}) can be a superadmin.` });
  }
  const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: `No user with email ${email}` });
  db.prepare("UPDATE users SET role = 'superadmin', email_verified = 1, plan = 'business', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
  console.log(`[promote-founder] User ${email} (id=${user.id}) promoted to superadmin`);
  res.json({ ok: true, message: `User ${email} promoted to superadmin (plan=business).`, userId: user.id });
});

// Sanitize errors — never leak DB schema or internal details
function safeError(err) {
  const msg = err.message || String(err);
  if (msg.includes('UNIQUE constraint')) return 'This record already exists.';
  if (msg.includes('FOREIGN KEY')) return 'Related record not found.';
  if (msg.includes('NOT NULL')) return 'Required field is missing.';
  if (msg.includes('CHECK constraint')) return 'Invalid value provided.';
  if (msg.includes('no such table') || msg.includes('no such column')) return 'System error. Please try again.';
  if (msg.includes('SQLITE')) return 'Database error. Please try again.';
  return msg;
}

// HTML escaper for email templates
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Contact form (public, no auth)
// Public enquiry form (sa landing + the parent site's "Talk to us"). The CRM
// write is the durable record; the email is a notification. Previously an email
// failure was swallowed and the visitor told "sent" while the enquiry vanished.
const contactLimiter = rateLimit({
  windowMs: 60_000, max: 5, validate: false,
  message: { error: 'Too many messages. Please wait a minute and try again.' },
});
function siteFromOrigin(origin) {
  const host = (() => { try { return new URL(origin).hostname; } catch { return ''; } })();
  if (host === 'eiaawsolutions.com' || host === 'www.eiaawsolutions.com') return 'parent';
  if (host.startsWith('sa.')) return 'sales_agent';
  return 'unknown';
}
app.post('/api/contact', contactLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().slice(0, 160).toLowerCase();
    const phone = String(b.phone || '').trim().slice(0, 40);
    const company = String(b.company || '').trim().slice(0, 160);
    const message = String(b.message || '').trim().slice(0, 4000);
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });

    const origin = req.headers['origin'] || req.headers['referer'] || '';
    let savedToCrm = false;
    try {
      saveInboundLead({
        name, email, phone, company,
        site: b.site ? normaliseSite(b.site) : siteFromOrigin(origin),
        channel: 'contact_form',
        // The consent record is appended to the message by the site; keep the
        // tail so it survives the 500-char note cap.
        note: message.length > 500 ? '…' + message.slice(-499) : message,
        origin,
      });
      savedToCrm = true;
    } catch (dbErr) {
      console.error('[contact] CRM save failed:', dbErr.message, 'From:', email);
    }

    const subject = `[SalesAgent Enquiry] ${escHtml(name)} — ${escHtml(company || 'Individual')}`;
    const html = `
      <h2>New Enquiry from SalesAgent Landing Page</h2>
      <table style="border-collapse:collapse;width:100%;max-width:500px">
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Name</td><td style="padding:8px;border-bottom:1px solid #ddd">${escHtml(name)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Email</td><td style="padding:8px;border-bottom:1px solid #ddd">${escHtml(email)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Phone</td><td style="padding:8px;border-bottom:1px solid #ddd">${escHtml(phone || 'Not provided')}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Company</td><td style="padding:8px;border-bottom:1px solid #ddd">${escHtml(company || 'Not provided')}</td></tr>
      </table>
      <h3 style="margin-top:20px">Message</h3>
      <p style="background:#f5f5f5;padding:16px;border-radius:8px;white-space:pre-wrap">${escHtml(message)}</p>
      <hr style="margin-top:24px">
      <p style="color:#999;font-size:12px">Sent from EIAAW SalesAgent landing page</p>
    `;

    let emailed = false;
    try {
      const result = await sendEmail({ to: 'eiaawsolutions@gmail.com', subject, html, replyTo: email });
      console.log('[contact] sent via', result.method, result.id ? '(id=' + result.id + ')' : '', 'from:', email);
      emailed = true;
    } catch (sendErr) {
      console.error('[contact] send failed:', sendErr.message, savedToCrm ? '— saved to CRM.' : '— NOT saved anywhere.', 'From:', email);
    }

    if (!savedToCrm && !emailed) {
      return res.status(502).json({ error: 'We could not send your message just now. Please email eiaawsolutions@gmail.com directly.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[contact] handler error:', err.message);
    res.status(500).json({ error: 'We could not send your message just now. Please email eiaawsolutions@gmail.com directly.' });
  }
});

// AI usage stats (superadmin only)
app.get('/api/admin/ai-usage', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });

  const total = db.prepare('SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls, COALESCE(SUM(total_tokens),0) as tokens FROM ai_cost_log').get();
  const thisMonth = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls FROM ai_cost_log WHERE created_at >= datetime('now','start of month')").get();
  const lastMonth = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as cost, COUNT(*) as calls FROM ai_cost_log WHERE created_at >= datetime('now','start of month','-1 month') AND created_at < datetime('now','start of month')").get();
  const daily = db.prepare("SELECT date(created_at) as day, SUM(cost_usd) as cost, COUNT(*) as calls FROM ai_cost_log WHERE created_at >= datetime('now','-7 days') GROUP BY date(created_at) ORDER BY day").all();
  const byModel = db.prepare("SELECT model, COUNT(*) as calls, SUM(cost_usd) as cost FROM ai_cost_log GROUP BY model ORDER BY cost DESC").all();
  const byType = db.prepare("SELECT task_type, COUNT(*) as calls, SUM(cost_usd) as cost FROM ai_cost_log GROUP BY task_type ORDER BY cost DESC").all();

  res.json({ total, thisMonth, lastMonth, daily, byModel, byType });
});

// Operating expenses stats (superadmin only)
app.get('/api/admin/opex', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });

  // Voice calls this month (from activities table)
  const voiceCalls = db.prepare(
    "SELECT COUNT(*) as count FROM activities WHERE type = 'voice_call' AND created_at >= datetime('now','start of month')"
  ).get();

  // Emails sent this month (from outreach_queue + campaigns)
  const emailsSent = db.prepare(
    "SELECT COUNT(*) as count FROM outreach_queue WHERE status = 'sent' AND sent_at >= datetime('now','start of month')"
  ).get();

  // Check which services are configured
  const resendKey = db.prepare("SELECT value FROM settings WHERE key = 'resend_api_key'").get();
  const voiceKey = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_api_key'").get();
  const apolloKey = db.prepare("SELECT value FROM settings WHERE key = 'apollo_api_key'").get();

  // Anthropic web_search tool spend this month (split out from AI tokens row).
  // Each row in ai_cost_log carries cost_usd that already includes web search;
  // we re-derive the search-only portion via the web_search_requests count.
  const webSearch = db.prepare(
    "SELECT COALESCE(SUM(web_search_requests), 0) AS searches FROM ai_cost_log WHERE created_at >= datetime('now','start of month')"
  ).get();
  const webSearchesThisMonth = Number(webSearch?.searches || 0);

  res.json({
    voiceCalls: voiceCalls.count,
    emailsSent: emailsSent.count,
    hasResend: !!(resendKey?.value && resendKey.value.length > 5),
    hasVoice: !!(voiceKey?.value && voiceKey.value.length > 5),
    hasApollo: !!(apolloKey?.value && apolloKey.value.length > 5),
    apolloMonthlyUsd: 99, // EIAAW Apollo plan — Professional seat
    webSearchesThisMonth,
    webSearchCostUsd: webSearchesThisMonth * 0.01, // $10 per 1k searches
  });
});

// Cleanup: list/delete pseudo-email AI-generated leads. Two-phase:
//   GET  → dry-run audit (count + 10 sample rows). Always safe, never writes.
//   POST → executes the cascade DELETE. Requires { confirm: true } in body.
// Targets: source='ai_generated' AND email LIKE '%@noemail.leads.local'.
// Cascade scope: campaign_leads, outreach_queue, activities, appointments, pipeline.
app.get('/api/admin/cleanup/pseudo-leads', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });

  const where = "source = 'ai_generated' AND email LIKE '%@noemail.leads.local'";
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM leads WHERE ${where}) AS leads,
      (SELECT COUNT(*) FROM campaign_leads WHERE lead_id IN (SELECT id FROM leads WHERE ${where})) AS campaign_leads,
      (SELECT COUNT(*) FROM outreach_queue WHERE lead_id IN (SELECT id FROM leads WHERE ${where})) AS outreach_queue,
      (SELECT COUNT(*) FROM activities WHERE lead_id IN (SELECT id FROM leads WHERE ${where})) AS activities,
      (SELECT COUNT(*) FROM appointments WHERE lead_id IN (SELECT id FROM leads WHERE ${where})) AS appointments,
      (SELECT COUNT(*) FROM pipeline WHERE lead_id IN (SELECT id FROM leads WHERE ${where})) AS pipeline
  `).get();

  const sample = db.prepare(`
    SELECT id, name, email, company, user_id, created_at
    FROM leads WHERE ${where}
    ORDER BY created_at DESC LIMIT 10
  `).all();

  res.json({ dryRun: true, criteria: where, totals, sample });
});

app.post('/api/admin/cleanup/pseudo-leads', requireAuth, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Refusing to delete without { confirm: true }. Run GET first to preview.' });
  }

  const where = "source = 'ai_generated' AND email LIKE '%@noemail.leads.local'";
  const ids = db.prepare(`SELECT id FROM leads WHERE ${where}`).all().map(r => r.id);
  if (!ids.length) return res.json({ deleted: 0, message: 'No matching leads found.' });

  // Build IN clauses with placeholders. SQLite limits parameter count, so chunk if huge.
  const chunk = (arr, size) => arr.length > size ? [arr.slice(0, size), ...chunk(arr.slice(size), size)] : [arr];
  const chunks = chunk(ids, 500);

  const result = { leadIds: ids.length, campaign_leads: 0, outreach_queue: 0, activities: 0, appointments: 0, pipeline: 0, leads: 0 };

  const deleteAll = db.transaction(() => {
    for (const idsChunk of chunks) {
      const placeholders = idsChunk.map(() => '?').join(',');
      result.campaign_leads += db.prepare(`DELETE FROM campaign_leads WHERE lead_id IN (${placeholders})`).run(...idsChunk).changes;
      result.outreach_queue += db.prepare(`DELETE FROM outreach_queue WHERE lead_id IN (${placeholders})`).run(...idsChunk).changes;
      result.activities    += db.prepare(`DELETE FROM activities WHERE lead_id IN (${placeholders})`).run(...idsChunk).changes;
      result.appointments  += db.prepare(`DELETE FROM appointments WHERE lead_id IN (${placeholders})`).run(...idsChunk).changes;
      result.pipeline      += db.prepare(`DELETE FROM pipeline WHERE lead_id IN (${placeholders})`).run(...idsChunk).changes;
      result.leads         += db.prepare(`DELETE FROM leads WHERE id IN (${placeholders})`).run(...idsChunk).changes;
    }
  });
  deleteAll();

  console.log(`[cleanup] Superadmin ${req.user.id} deleted ${result.leads} pseudo-email AI leads + cascade:`, result);
  res.json({ deleted: result.leads, cascade: result });
});

// System metrics (superadmin only) — cached by midnight cron job
app.get('/api/admin/metrics', requireAuth, async (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
  const cached = db.prepare("SELECT value FROM settings WHERE key = 'system_metrics'").get();
  if (cached?.value) return res.json(JSON.parse(cached.value));
  // First request before midnight job has run — compute now
  const { refreshMetrics } = await import('./services/metrics.js');
  const metrics = await refreshMetrics();
  res.json(metrics || {});
});

// Public chatbot endpoint (for landing page visitor conversion)
app.post('/api/chatbot', rateLimit({ windowMs: 60000, max: 5, message: { error: 'Chat limit reached. Try again in a minute.' }, validate: false }), async (req, res) => {
  try {
    const { message, source } = req.body;
    if (!message || message.length > 500) return res.status(400).json({ error: 'Message required (max 500 chars).' });

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
    const { decrypt: dec } = await import('./utils/crypto.js');
    const apiKey = apiKeyRow?.value ? dec(apiKeyRow.value) : process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ response: "Chat is currently unavailable. Please use the contact form or email eiaawsolutions@gmail.com" });

    const client = new Anthropic({ apiKey });
    const CHATBOT_DEFAULT_MODEL = 'claude-sonnet-4-6';
    const RETIRED_MODELS = new Set(['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620']);
    const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_model'").get();
    const storedModel = modelRow?.value;
    const model = (!storedModel || RETIRED_MODELS.has(storedModel)) ? CHATBOT_DEFAULT_MODEL : storedModel;

    const response = await client.messages.create({
      model,
      max_tokens: 300,
      system: await buildChatbotPrompt(req.headers['origin'] || req.headers['referer'] || '', source),
      messages: [{ role: 'user', content: message }],
    });

    const reply = response.content?.[0]?.text || "I'd love to tell you more! Please leave your details in the contact form and our team will reach out.";

    db.prepare("INSERT INTO ai_cost_log (campaign_id, task_type, input_tokens, output_tokens, total_tokens, cost_usd, model, user_id) VALUES (NULL, 'chatbot', ?, ?, ?, ?, ?, 1)")
      .run(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0,
        (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0), 0.005, model);

    res.json({ response: reply });
  } catch (err) {
    console.error('[chatbot] Anthropic call failed:', err?.status || '', err?.message || err);
    res.json({ response: "I'm having trouble connecting right now. Please email us at eiaawsolutions@gmail.com or pick a plan at sa.eiaawsolutions.com/#pricing" });
  }
});

// Public routes (no auth)
app.use('/api/auth', authRouter);
app.use('/api/billing', billingRouter);

// Protected routes
app.use('/api/users', usersRouter);
app.use('/api/leads', requireAuth, leadsRouter);
app.use('/api/campaigns', requireAuth, campaignsRouter);
app.use('/api/pipeline', requireAuth, pipelineRouter);
app.use('/api/agent', requireAuth, agentRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/system-logic', requireAuth, systemLogicRouter);
app.use('/api/voice', voiceRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/tracking', trackingRouter);
app.use('/api/uploads', requireAuth, uploadsRouter);
// Forms router handles its own auth split — public submit/fetch routes come
// before requireAuth inside the router. Don't wrap with requireAuth here.
app.use('/api/forms', formsRouter);

// Omnichannel lead funnel.
// /api/ingest is PUBLIC by design — the ingest_key in the path selects the
// tenant and the signature authenticates the sender. It must NOT be wrapped in
// requireAuth: Google, Calendly, and Resend have no session.
app.use('/api/ingest', ingestRouter);
app.use('/api/sources', requireAuth, sourcesRouter);
app.use('/api/segments', requireAuth, segmentsRouter);

// Dashboard overview endpoint
app.get('/api/dashboard', requireAuth, (req, res) => {
  const userId = req.user.id;
  const isSuperadmin = req.user.role === 'superadmin';
  const uf = isSuperadmin ? '' : ' AND user_id = ?';
  const uw = isSuperadmin ? '' : ' WHERE user_id = ?';
  const p = isSuperadmin ? [] : [userId];

  const leads = db.prepare(`SELECT COUNT(*) as count FROM leads${uw}`).get(...p);
  const newLeads = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE status = 'new'${uf}`).get(...p);
  const qualifiedLeads = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE status = 'qualified'${uf}`).get(...p);

  const openDeals = db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(deal_value),0) as value FROM pipeline WHERE stage NOT IN ('closed_won','closed_lost')${uf}`
  ).get(...p);
  const wonDeals = db.prepare(
    `SELECT COUNT(*) as count, COALESCE(SUM(deal_value),0) as value FROM pipeline WHERE stage = 'closed_won'${uf}`
  ).get(...p);

  const activeCampaigns = db.prepare(`SELECT COUNT(*) as count FROM campaigns WHERE status = 'active'${uf}`).get(...p);
  const totalSent = db.prepare(`SELECT COALESCE(SUM(sent_count),0) as count FROM campaigns${uw}`).get(...p);

  const recentActivities = db.prepare(
    `SELECT a.*, l.name as lead_name FROM activities a LEFT JOIN leads l ON a.lead_id = l.id WHERE 1=1${uf.replace('user_id', 'a.user_id')} ORDER BY a.created_at DESC LIMIT 10`
  ).all(...p);

  let topLeads = db.prepare(`SELECT * FROM leads${uw} ORDER BY score DESC LIMIT 5`).all(...p);

  const aiCost = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) as total FROM ai_cost_log${uw}`).get(...p);

  // Apply masking for non-superadmin users
  if (!isSuperadmin) {
    topLeads = maskLeads(topLeads);
    for (const a of recentActivities) {
      if (a.lead_name) a.lead_name = maskLead({ name: a.lead_name, email: '', phone: '' }).name;
      // Mask emails/phones embedded in activity descriptions
      a.description = a.description
        .replace(/[\w.-]+@[\w.-]+\.\w+/g, (email) => maskLead({ name: '', email, phone: '' }).email)
        .replace(/(\+?\d[\d\s-]{7,}\d)/g, (phone) => maskLead({ name: '', email: '', phone }).phone);
    }
  }

  res.json({
    leads: { total: leads.count, new: newLeads.count, qualified: qualifiedLeads.count },
    deals: { open: openDeals.count, openValue: openDeals.value, won: wonDeals.count, wonValue: wonDeals.value },
    campaigns: { active: activeCampaigns.count, totalSent: totalSent.count },
    recentActivities,
    topLeads,
    aiCost: aiCost.total,
    monthlySystemCost: req.user.monthlySystemCost || 0,
  });
});

// App (login/dashboard) at /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});
app.get('/app/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// Landing page as homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

// Global error handler — catch unhandled errors, return safe JSON
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: safeError(err) });
  }
  next(err);
});

// Public form page (recipients fill this in). No auth, no CSRF.
app.get('/f/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'form.html'));
});

// Unknown URLs are real 404s. The old SPA fallback served the landing page
// with 200 for every path, which search engines index as duplicate "soft 404s".
app.all('/api/*', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('*', (req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

const PORT = process.env.PORT || config.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EIAAW SalesAgent running on port ${PORT}`);
  startScheduler();
  // Warm the chatbot's parent-site facts so the first visitor doesn't wait on the fetch.
  getParentFacts().catch(() => {});
});
