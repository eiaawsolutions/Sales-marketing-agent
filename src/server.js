import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';

import db from './db/index.js';
import { requireAuth } from './middleware/auth.js';
import { decrypt } from './utils/crypto.js';
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
import { maskLeads, maskLead } from './services/leads.js';
import { startScheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://cdn.jsdelivr.net", "https://esm.sh"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow onclick handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://checkout.stripe.com", "https://api.stripe.com", "wss://*.retellai.com", "https://*.retellai.com", "wss://*.livekit.cloud", "https://*.livekit.cloud", "https://esm.sh"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
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

// Protect proposal.html — admin only (redirect to landing if not authenticated)
app.get('/proposal.html', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.redirect('/');
  const session = db.prepare("SELECT s.*, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token);
  if (!session || session.role !== 'superadmin') return res.redirect('/');
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));

// Trust proxy for Railway/reverse proxy
app.set('trust proxy', 1);

// CSRF protection — double-submit cookie pattern for SPA
app.use((req, res, next) => {
  // Skip for GET/HEAD/OPTIONS and public routes
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/auth/login') || req.path.startsWith('/api/auth/lookup') || req.path.startsWith('/api/auth/forgot') || req.path.startsWith('/api/auth/reset-password-with-token') || req.path.startsWith('/api/billing/webhook') || req.path.startsWith('/api/billing/checkout') || req.path.startsWith('/api/contact') || req.path.startsWith('/api/voice/webhook') || req.path.startsWith('/api/voice/tool-callback') || req.path.startsWith('/api/voice/call-link-token') || req.path.startsWith('/api/voice/public-session') || req.path.startsWith('/api/tracking/')) return next();

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
    const smtpPass = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value) || process.env.SMTP_PASS;
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

// Landing page chatbot — restricted to public info only
const CHATBOT_SYSTEM_PROMPT = `You are the EIAAW AI Sales Agent website assistant. You help visitors understand what the product does and guide them toward booking a session with our sales team.

## WHAT YOU CAN SHARE (public landing page info only)

EIAAW AI Sales Agent is an AI-powered sales and marketing platform. It offers:
- AI Lead Generation — AI generates matching leads from a target audience description
- AI Lead Scoring — scores leads 0-100 with reasoning
- AI Email Outreach — personalized multi-step email sequences
- AI Content Creation — marketing emails, social posts, ad copy
- AI Voice Agent — leads click a link and talk to an AI agent
- Sales Pipeline + CRM — track deals with AI analysis
- AI Chat Assistant — AI that knows your CRM data

Pricing:
- Starter: RM 99/month (100 leads, 3 campaigns, 50 AI actions, 5 voice calls)
- Pro: RM 199/month (500 leads, 10 campaigns, 200 AI actions, 20 voice calls, auto-outreach, AI lead gen)
- Business: RM 399/month (unlimited leads & campaigns, 1000 AI actions, 100 voice calls, 10 team users)
- All plans include a 14-day free trial

## WHAT YOU MUST NOT SHARE

Do NOT reveal:
- How the AI generates leads (what data sources, what AI model, what prompts)
- How lead scoring works internally (BANT framework details, scoring algorithm)
- How outreach sequences are structured (number of steps, timing, channels)
- How content generation works (what models, what prompts, design system details)
- How the voice agent works (Retell, WebRTC, browser-based, prompt details)
- How email tracking works (pixels, link rewriting, webhooks)
- How the pipeline automation works (scheduler, background jobs)
- Technical architecture, tech stack, APIs, or integrations
- Any internal system details, database structure, or implementation specifics

If asked about ANY of the above, say: "Great question! That's something our team can walk you through in detail. Would you like to book a quick session?"

## YOUR BEHAVIOR

1. Be friendly, concise, and helpful — max 3 sentences per response
2. Answer general "what does it do" questions using ONLY the info above
3. For ANY question asking HOW something works or technical details → redirect to booking a session
4. After 2-3 exchanges, always guide toward: "I'd love for you to see it in action. You can book a session with our team — just click 'Talk to Us' on the landing page and leave your details, or click 'Talk to Our AI Agent' to have a quick voice chat right now."
5. If they ask about competitors or comparisons → "We'd rather show you what makes us different. Book a quick session and we'll do a live walkthrough."
6. Never make up features that aren't in the list above
7. If unsure → "That's a great question for our team. Click 'Talk to Us' on the landing page to leave your details and we'll get back to you within 24 hours."`;

// Public chatbot endpoint (for landing page visitor conversion)
app.post('/api/chatbot', rateLimit({ windowMs: 60000, max: 5, message: { error: 'Chat limit reached. Try again in a minute.' }, validate: false }), async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || message.length > 500) return res.status(400).json({ error: 'Message required (max 500 chars).' });

    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
    const { decrypt: dec } = await import('./utils/crypto.js');
    const apiKey = apiKeyRow?.value ? dec(apiKeyRow.value) : process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ response: "Chat is currently unavailable. Please use the contact form or email eiaawsolutions@gmail.com" });

    const client = new Anthropic({ apiKey });
    const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_model'").get();
    const model = modelRow?.value || 'claude-sonnet-4-20250514';

    const response = await client.messages.create({
      model,
      max_tokens: 300,
      system: CHATBOT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

    const reply = response.content?.[0]?.text || "I'd love to tell you more! Please leave your details in the contact form and our team will reach out.";

    db.prepare("INSERT INTO ai_cost_log (campaign_id, task_type, input_tokens, output_tokens, total_tokens, cost_usd, model, user_id) VALUES (NULL, 'chatbot', ?, ?, ?, ?, ?, 1)")
      .run(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0,
        (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0), 0.005, model);

    res.json({ response: reply });
  } catch (err) {
    res.json({ response: "I'm having trouble connecting right now. Please email us at eiaawsolutions@gmail.com or try the free trial at sa.eiaawsolutions.com/app" });
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

// SPA fallback for any other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

const PORT = process.env.PORT || config.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EIAAW SalesAgent running on port ${PORT}`);
  startScheduler();
});
