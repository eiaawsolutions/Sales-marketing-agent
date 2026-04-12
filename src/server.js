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
  contentSecurityPolicy: false, // SPA needs inline scripts
  crossOriginEmbedderPolicy: false,
}));

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Trust proxy for Railway/reverse proxy
app.set('trust proxy', 1);

// Rate limiting
app.use('/api', rateLimit({ windowMs: 60000, max: 120, message: { error: 'Too many requests. Please slow down.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 900000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } }));
app.use('/api/agent', rateLimit({ windowMs: 60000, max: 10, message: { error: 'AI rate limit reached. Wait a moment.' } }));

// Health check (no auth)
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

// Contact form (public, no auth)
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, company, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message are required.' });

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
        subject: `[SalesAgent Enquiry] ${name} — ${company || 'Individual'}`,
        html: `
          <h2>New Enquiry from SalesAgent Landing Page</h2>
          <table style="border-collapse:collapse;width:100%;max-width:500px">
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Name</td><td style="padding:8px;border-bottom:1px solid #ddd">${name}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Email</td><td style="padding:8px;border-bottom:1px solid #ddd"><a href="mailto:${email}">${email}</a></td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Phone</td><td style="padding:8px;border-bottom:1px solid #ddd">${phone || 'Not provided'}</td></tr>
            <tr><td style="padding:8px;font-weight:bold;border-bottom:1px solid #ddd">Company</td><td style="padding:8px;border-bottom:1px solid #ddd">${company || 'Not provided'}</td></tr>
          </table>
          <h3 style="margin-top:20px">Message</h3>
          <p style="background:#f5f5f5;padding:16px;border-radius:8px;white-space:pre-wrap">${message}</p>
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

// SPA fallback for any other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'landing.html'));
});

const PORT = process.env.PORT || config.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EIAAW SalesAgent running on port ${PORT}`);
});
