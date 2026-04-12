import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';

import db from './db/index.js';
import { requireAuth } from './middleware/auth.js';
import authRouter from './routes/auth.js';
import billingRouter from './routes/billing.js';
import usersRouter from './routes/users.js';
import leadsRouter from './routes/leads.js';
import campaignsRouter from './routes/campaigns.js';
import pipelineRouter from './routes/pipeline.js';
import agentRouter from './routes/agent.js';
import settingsRouter from './routes/settings.js';
import systemLogicRouter from './routes/system-logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://checkout.stripe.com", "https://api.stripe.com"],
      frameSrc: ["https://js.stripe.com", "https://checkout.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['https://sa.eiaawsolutions.com', 'https://sales-marketing-agent-production.up.railway.app', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Trust proxy for Railway/reverse proxy
app.set('trust proxy', 1);

// CSRF protection — double-submit cookie pattern for SPA
app.use((req, res, next) => {
  // Skip for GET/HEAD/OPTIONS and public routes
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/auth/login') || req.path.startsWith('/api/auth/forgot') || req.path.startsWith('/api/auth/reset-password-with-token') || req.path.startsWith('/api/billing/webhook') || req.path.startsWith('/api/billing/checkout') || req.path.startsWith('/api/contact')) return next();

  // For authenticated requests, Bearer token in Authorization header provides CSRF protection
  // because third-party sites cannot set custom headers in cross-origin requests
  const hasAuthHeader = req.headers['authorization']?.startsWith('Bearer ');
  if (hasAuthHeader) return next();

  // For unauthenticated POST requests (checkout, etc.), check origin
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  const allowed = ['https://sa.eiaawsolutions.com', 'https://sales-marketing-agent-production.up.railway.app', 'http://localhost:3000'];
  if (allowed.some(a => origin.startsWith(a))) return next();

  return res.status(403).json({ error: 'Request blocked — invalid origin.' });
});

// Rate limiting (validate:false to avoid IPv6 errors on Railway)
app.use('/api', rateLimit({ windowMs: 60000, max: 120, message: { error: 'Too many requests. Please slow down.' }, validate: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 900000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' }, validate: false }));
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

// Health check (no auth)
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
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
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, company, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required.' });
    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });

    const nodemailer = (await import('nodemailer')).default;
    const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value || process.env.SMTP_HOST;
    const smtpPort = db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || process.env.SMTP_PORT || '587';
    const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value || process.env.SMTP_USER;
    const smtpPass = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value || process.env.SMTP_PASS;
    const fromEmail = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value || process.env.FROM_EMAIL;

    if (smtpUser && smtpHost) {
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: parseInt(smtpPort), secure: parseInt(smtpPort) === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });

      await transporter.sendMail({
        from: fromEmail || smtpUser,
        to: 'eiaawsolutions@gmail.com',
        replyTo: email,
        subject: `[SalesAgent Enquiry] ${escHtml(name)} — ${escHtml(company || 'Individual')}`,
        html: `
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
        `,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Contact form error:', err.message);
    res.json({ success: true }); // Don't reveal email errors to user
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

  const topLeads = db.prepare(`SELECT * FROM leads${uw} ORDER BY score DESC LIMIT 5`).all(...p);

  const aiCost = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) as total FROM ai_cost_log${uw}`).get(...p);

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

// SPA fallback for any other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

const PORT = process.env.PORT || config.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EIAAW SalesAgent running on port ${PORT}`);
});
