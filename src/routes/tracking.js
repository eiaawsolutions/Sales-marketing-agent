import { Router } from 'express';
import db from '../db/index.js';
import { verifyTracking } from '../utils/tracking-token.js';

const router = Router();

// 1x1 transparent GIF as a Buffer
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function sendPixel(res) {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(PIXEL);
}

// Look up the campaign owner so the activity row is attributed correctly
// (the previous version hard-coded user_id=1, dumping every tracked event
// into admin's tenant). Returns null if the campaign no longer exists.
function getCampaignOwner(campaignId) {
  const row = db.prepare('SELECT user_id FROM campaigns WHERE id = ?').get(campaignId);
  return row?.user_id || null;
}

// GET /api/tracking/open/:campaignId/:leadId?t=<hmac> — tracking pixel (email open)
// HMAC token bound to the (campaign,lead) pair. Without a valid token the
// endpoint returns the pixel but writes nothing — external scrapers / bots
// can't pollute analytics by guessing IDs in a loop.
router.get('/open/:campaignId/:leadId', (req, res) => {
  try {
    const { campaignId, leadId } = req.params;
    const token = req.query.t;
    if (!verifyTracking(campaignId, leadId, token)) return sendPixel(res);

    const ownerId = getCampaignOwner(campaignId);

    db.prepare(`
      UPDATE campaign_leads SET status = 'opened', opened_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND lead_id = ? AND status = 'sent'
    `).run(campaignId, leadId);

    db.prepare('UPDATE campaigns SET open_count = open_count + 1 WHERE id = ?').run(campaignId);

    // Only bump scores / log activity for leads the campaign owner actually owns
    // (defence in depth — the HMAC already binds the pair, but if a campaign
    // somehow contains a foreign lead, we don't pollute another tenant's data).
    if (ownerId) {
      db.prepare('UPDATE leads SET score = MIN(score + 5, 100), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run(leadId, ownerId);
      db.prepare("INSERT OR IGNORE INTO activities (lead_id, campaign_id, type, description, user_id) VALUES (?, ?, 'email', 'Opened campaign email', ?)")
        .run(leadId, campaignId, ownerId);
    }
  } catch (e) {
    // Never fail — always return the pixel so the email renders cleanly.
  }
  sendPixel(res);
});

// GET /api/tracking/click/:campaignId/:leadId?t=<hmac>&url= — link click tracker
router.get('/click/:campaignId/:leadId', (req, res) => {
  const targetUrl = req.query.url;
  // Validate URL — only http/https to prevent open redirect.
  if (!targetUrl || (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://'))) {
    return res.status(400).send('Invalid link');
  }
  try {
    const { campaignId, leadId } = req.params;
    const token = req.query.t;
    if (!verifyTracking(campaignId, leadId, token)) {
      // Token invalid — still redirect so legitimate users (e.g. forwarded
      // emails) reach the destination, but record nothing.
      return res.redirect(302, targetUrl);
    }

    const ownerId = getCampaignOwner(campaignId);

    db.prepare(`
      UPDATE campaign_leads SET status = 'clicked', clicked_at = CURRENT_TIMESTAMP
      WHERE campaign_id = ? AND lead_id = ? AND status IN ('sent', 'opened')
    `).run(campaignId, leadId);

    db.prepare('UPDATE campaigns SET click_count = click_count + 1 WHERE id = ?').run(campaignId);

    if (ownerId) {
      db.prepare('UPDATE leads SET score = MIN(score + 10, 100), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
        .run(leadId, ownerId);
      db.prepare("INSERT INTO activities (lead_id, campaign_id, type, description, user_id) VALUES (?, ?, 'email', ?, ?)")
        .run(leadId, campaignId, `Clicked link in campaign email: ${targetUrl.substring(0, 100)}`, ownerId);
    }

    res.redirect(302, targetUrl);
  } catch (e) {
    res.redirect(302, targetUrl);
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
