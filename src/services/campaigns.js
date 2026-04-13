import db from '../db/index.js';
import nodemailer from 'nodemailer';
import { decrypt } from '../utils/crypto.js';

// Read SMTP settings from DB (consistent with auth, billing, contact form)
function getSmtpConfig() {
  const get = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || '';
  const host = get('smtp_host') || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(get('smtp_port') || process.env.SMTP_PORT || '587');
  const user = get('smtp_user') || process.env.SMTP_USER || '';
  const rawPass = get('smtp_pass');
  const pass = (rawPass ? decrypt(rawPass) : null) || process.env.SMTP_PASS || '';
  const from = get('from_email') || process.env.FROM_EMAIL || '';
  return { host, port, user, pass, from };
}

function createTransporter() {
  const smtp = getSmtpConfig();
  if (!smtp.user) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 10000, // 10s connection timeout
    greetingTimeout: 10000,
    socketTimeout: 15000,     // 15s socket timeout
  });
}

export const campaignsService = {
  getAll(userId, filters = {}) {
    let query = 'SELECT * FROM campaigns WHERE 1=1';
    const params = [];

    if (userId) { query += ' AND user_id = ?'; params.push(userId); }
    if (filters.status) { query += ' AND status = ?'; params.push(filters.status); }
    if (filters.type) { query += ' AND type = ?'; params.push(filters.type); }

    query += ' ORDER BY created_at DESC';
    return db.prepare(query).all(...params);
  },

  getById(userId, id) {
    const campaign = userId
      ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(id, userId)
      : db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    if (!campaign) return null;

    campaign.leads = db.prepare(`
      SELECT l.*, cl.status as campaign_status, cl.sent_at, cl.opened_at
      FROM campaign_leads cl JOIN leads l ON cl.lead_id = l.id
      WHERE cl.campaign_id = ?
    `).all(id);

    return campaign;
  },

  create(userId, campaign) {
    const result = db.prepare(`
      INSERT INTO campaigns (user_id, name, type, subject, body, target_audience, scheduled_at, budget_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, campaign.name, campaign.type, campaign.subject,
      campaign.body, campaign.target_audience, campaign.scheduled_at,
      campaign.budget_limit || 0
    );
    return this.getById(null, result.lastInsertRowid);
  },

  update(userId, id, data) {
    if (userId) {
      const existing = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(id, userId);
      if (!existing) return null;
    }

    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(data)) {
      if (['name', 'type', 'status', 'subject', 'body', 'target_audience', 'scheduled_at', 'budget_limit'].includes(key)) {
        fields.push(`${key} = ?`);
        params.push(value);
      }
    }
    if (fields.length === 0) return this.getById(null, id);
    params.push(id);
    db.prepare(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(null, id);
  },

  delete(userId, id) {
    if (userId) {
      const existing = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(id, userId);
      if (!existing) return null;
    }
    db.prepare('DELETE FROM outreach_queue WHERE campaign_id = ?').run(id);
    db.prepare('DELETE FROM campaign_leads WHERE campaign_id = ?').run(id);
    return db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  },

  addLeads(campaignId, leadIds) {
    const stmt = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)');
    const addMany = db.transaction((ids) => {
      for (const leadId of ids) stmt.run(campaignId, leadId);
    });
    addMany(leadIds);
    return this.getById(null, campaignId);
  },

  async sendCampaign(userId, campaignId) {
    const campaign = this.getById(userId, campaignId);
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.type !== 'email') throw new Error('Only email campaigns can be sent');
    if (!campaign.leads?.length) throw new Error('No leads assigned to campaign');

    const smtp = getSmtpConfig();
    const mailer = createTransporter();

    let sentCount = 0;
    const results = [];

    for (const lead of campaign.leads) {
      if (lead.campaign_status !== 'pending') continue;
      try {
        if (mailer) {
          await mailer.sendMail({
            from: smtp.from || smtp.user, to: lead.email,
            subject: campaign.subject, html: campaign.body,
          });
        }
        db.prepare('UPDATE campaign_leads SET status = ?, sent_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND lead_id = ?')
          .run('sent', campaignId, lead.id);
        db.prepare('INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?, ?, ?, ?, ?)')
          .run(userId || campaign.user_id, lead.id, campaignId, 'email', `Sent campaign: ${campaign.name}`);
        sentCount++;
        results.push({ leadId: lead.id, status: 'sent' });
      } catch (err) {
        db.prepare('UPDATE campaign_leads SET status = ? WHERE campaign_id = ? AND lead_id = ?')
          .run('bounced', campaignId, lead.id);
        results.push({ leadId: lead.id, status: 'bounced', error: err.message });
      }
    }

    db.prepare('UPDATE campaigns SET status = ?, sent_count = sent_count + ? WHERE id = ?')
      .run('active', sentCount, campaignId);

    return { sent: sentCount, total: campaign.leads.length, results };
  },

  getStats(userId) {
    const uw = userId ? ' WHERE user_id = ?' : '';
    const uf = userId ? ' AND user_id = ?' : '';
    const p = userId ? [userId] : [];

    const total = db.prepare(`SELECT COUNT(*) as count FROM campaigns${uw}`).get(...p);
    const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM campaigns${uw} GROUP BY status`).all(...p);
    const byType = db.prepare(`SELECT type, COUNT(*) as count FROM campaigns${uw} GROUP BY type`).all(...p);
    const emailStats = db.prepare(
      `SELECT SUM(sent_count) as sent, SUM(open_count) as opened, SUM(click_count) as clicked FROM campaigns WHERE type = 'email'${uf}`
    ).get(...p);

    return { total: total.count, byStatus, byType, emailStats };
  },
};
