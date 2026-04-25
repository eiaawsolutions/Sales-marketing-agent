import db from '../db/index.js';
import { sendEmail } from '../utils/email.js';
import { signTracking } from '../utils/tracking-token.js';

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
      SELECT l.*, cl.status as campaign_status, cl.sent_at, cl.opened_at, cl.clicked_at
      FROM campaign_leads cl JOIN leads l ON cl.lead_id = l.id
      WHERE cl.campaign_id = ?
    `).all(id);

    return campaign;
  },

  create(userId, campaign) {
    const result = db.prepare(`
      INSERT INTO campaigns (user_id, name, type, subject, body, target_audience, scheduled_at, budget_limit, form_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, campaign.name, campaign.type, campaign.subject,
      campaign.body, campaign.target_audience, campaign.scheduled_at,
      campaign.budget_limit || 0,
      campaign.form_id ? parseInt(campaign.form_id) : null
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
      if (['name', 'type', 'status', 'subject', 'body', 'target_audience', 'scheduled_at', 'budget_limit', 'form_id'].includes(key)) {
        fields.push(`${key} = ?`);
        params.push(key === 'form_id' ? (value ? parseInt(value) : null) : value);
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

    // Get base URL for tracking
    const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value || 'https://sa.eiaawsolutions.com';

    let sentCount = 0;
    const results = [];

    for (const lead of campaign.leads) {
      if (lead.campaign_status !== 'pending') continue;
      try {
        // Append form CTA if a form is attached to this campaign
        const bodyWithForm = appendFormCta(campaign.body, campaign.form_id, campaignId, lead.id, baseUrl);
        // Inject tracking pixel and link tracking into email HTML
        const trackedHtml = injectTracking(bodyWithForm, campaignId, lead.id, baseUrl);

        await sendEmail({
          to: lead.email,
          subject: campaign.subject,
          html: trackedHtml,
        });

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

/**
 * Append a "Complete this form" CTA block to the email body if the campaign
 * has a form_id attached. The link carries cid + lid so submissions are
 * correlated back to the campaign/lead.
 */
export function appendFormCta(html, formId, campaignId, leadId, baseUrl) {
  if (!formId || !html) return html;
  const base = (baseUrl || 'https://sa.eiaawsolutions.com').replace(/\/+$/, '');
  const form = db.prepare('SELECT name, title, button_text FROM forms WHERE id = ?').get(formId);
  if (!form) return html;
  const label = form.button_text || 'Complete this form';
  const formUrl = `${base}/f/${formId}?cid=${campaignId}&lid=${leadId}`;
  const cta = `
    <div style="margin:28px 0;padding:20px;background:#f3eee4;border-radius:10px;text-align:center;font-family:Inter,Arial,sans-serif">
      <p style="margin:0 0 12px;color:#1a2a2e;font-size:14px">${form.title ? String(form.title).replace(/[<>]/g,'') : 'We’d love to hear from you.'}</p>
      <a href="${formUrl}" style="display:inline-block;background:#1FA896;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${String(label).replace(/[<>]/g,'')}</a>
    </div>
  `;
  if (html.includes('</body>')) return html.replace('</body>', cta + '</body>');
  return html + cta;
}

/**
 * Inject tracking pixel and rewrite links for click tracking.
 * Exported so scheduler and pipeline can reuse it.
 */
export function injectTracking(html, campaignId, leadId, baseUrl) {
  if (!html || !campaignId || !leadId) return html;
  const base = baseUrl || 'https://sa.eiaawsolutions.com';
  // Bind the (campaign, lead) pair to a short HMAC. The tracking endpoints
  // refuse the request without a valid token, so external scrapers / bots
  // can't pollute analytics or score by guessing IDs.
  const tk = signTracking(campaignId, leadId);

  // Rewrite <a href="https://..."> to go through click tracker (skip mailto: and # anchors)
  let tracked = html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (match, url) => {
      // Don't track our own tracking URLs
      if (url.includes('/api/tracking/')) return match;
      return `href="${base}/api/tracking/click/${campaignId}/${leadId}?t=${tk}&url=${encodeURIComponent(url)}"`;
    }
  );

  // Add tracking pixel at the end
  const pixel = `<img src="${base}/api/tracking/open/${campaignId}/${leadId}?t=${tk}" width="1" height="1" style="display:none;width:1px;height:1px" alt="" />`;
  if (tracked.includes('</body>')) {
    tracked = tracked.replace('</body>', pixel + '</body>');
  } else {
    tracked += pixel;
  }

  return tracked;
}
