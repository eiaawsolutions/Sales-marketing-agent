import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

// 1x1 transparent GIF as a Buffer
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// GET /api/tracking/open/:campaignId/:leadId — tracking pixel (email open)
router.get('/open/:campaignId/:leadId', (req, res) => {
  try {
    const { campaignId, leadId } = req.params;

    // Update campaign_leads status to opened (only if currently 'sent')
    db.prepare(`
      UPDATE campaign_leads SET status = 'opened', opened_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND lead_id = ? AND status = 'sent'
    `).run(campaignId, leadId);

    // Increment campaign open count
    db.prepare('UPDATE campaigns SET open_count = open_count + 1 WHERE id = ?').run(campaignId);

    // Bump lead score +5 (cap at 100)
    db.prepare('UPDATE leads SET score = MIN(score + 5, 100), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(leadId);

    // Log activity
    db.prepare("INSERT OR IGNORE INTO activities (lead_id, campaign_id, type, description, user_id) VALUES (?, ?, 'email', 'Opened campaign email', 1)")
      .run(leadId, campaignId);
  } catch (e) {
    // Never fail — always return the pixel
  }

  // Return 1x1 transparent GIF
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(PIXEL);
});

// GET /api/tracking/click/:campaignId/:leadId?url= — link click tracker
router.get('/click/:campaignId/:leadId', (req, res) => {
  try {
    const { campaignId, leadId } = req.params;
    const targetUrl = req.query.url;

    // Validate URL — only allow http/https to prevent open redirect attacks
    if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
      return res.status(400).send('Invalid link');
    }

    // Update campaign_leads status to clicked
    db.prepare(`
      UPDATE campaign_leads SET status = 'clicked', clicked_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND lead_id = ? AND status IN ('sent', 'opened')
    `).run(campaignId, leadId);

    // Increment campaign click count
    db.prepare('UPDATE campaigns SET click_count = click_count + 1 WHERE id = ?').run(campaignId);

    // Bump lead score +10 (cap at 100)
    db.prepare('UPDATE leads SET score = MIN(score + 10, 100), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(leadId);

    // Log activity
    db.prepare("INSERT INTO activities (lead_id, campaign_id, type, description, user_id) VALUES (?, ?, 'email', ?, 1)")
      .run(leadId, campaignId, `Clicked link in campaign email: ${targetUrl.substring(0, 100)}`);

    // Redirect to the actual URL
    res.redirect(302, targetUrl);
  } catch (e) {
    // Fallback: redirect to homepage if tracking fails
    const fallback = req.query.url || 'https://eiaawsolutions.com';
    res.redirect(302, fallback);
  }
});

// POST /api/tracking/webhook — Resend webhook receiver
router.post('/webhook', (req, res) => {
  try {
    const event = req.body;
    const type = event.type;
    const data = event.data || {};

    if (type === 'email.opened' && data.to) {
      const email = Array.isArray(data.to) ? data.to[0] : data.to;
      // Find the lead by email and update their latest campaign_leads entry
      const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get(email);
      if (lead) {
        const cl = db.prepare(`
          SELECT campaign_id FROM campaign_leads WHERE lead_id = ? AND status = 'sent'
          ORDER BY sent_at DESC LIMIT 1
        `).get(lead.id);
        if (cl) {
          db.prepare("UPDATE campaign_leads SET status = 'opened', opened_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND lead_id = ? AND status = 'sent'")
            .run(cl.campaign_id, lead.id);
          db.prepare('UPDATE campaigns SET open_count = open_count + 1 WHERE id = ?').run(cl.campaign_id);
          db.prepare('UPDATE leads SET score = MIN(score + 5, 100) WHERE id = ?').run(lead.id);
        }
      }
    }

    if (type === 'email.clicked' && data.to) {
      const email = Array.isArray(data.to) ? data.to[0] : data.to;
      const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get(email);
      if (lead) {
        const cl = db.prepare(`
          SELECT campaign_id FROM campaign_leads WHERE lead_id = ? AND status IN ('sent','opened')
          ORDER BY sent_at DESC LIMIT 1
        `).get(lead.id);
        if (cl) {
          db.prepare("UPDATE campaign_leads SET status = 'clicked', clicked_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND lead_id = ?")
            .run(cl.campaign_id, lead.id);
          db.prepare('UPDATE campaigns SET click_count = click_count + 1 WHERE id = ?').run(cl.campaign_id);
          db.prepare('UPDATE leads SET score = MIN(score + 10, 100) WHERE id = ?').run(lead.id);
        }
      }
    }

    if (type === 'email.bounced' && data.to) {
      const email = Array.isArray(data.to) ? data.to[0] : data.to;
      const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get(email);
      if (lead) {
        db.prepare("UPDATE campaign_leads SET status = 'bounced' WHERE lead_id = ? AND status = 'sent'").run(lead.id);
      }
    }
  } catch (e) {
    console.error('Tracking webhook error:', e.message);
  }

  // Always return 200 for webhooks
  res.json({ received: true });
});

export default router;
