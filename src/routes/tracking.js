import { Router } from 'express';
import db from '../db/index.js';
import { verifyTracking } from '../utils/tracking-token.js';
import { verifySvix } from '../services/ingest-auth.js';
import { recordEmailEvent } from '../services/email-events.js';

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

// POST /api/tracking/webhook — Resend webhook receiver.
// Resend signs every delivery with Svix; server.js mounts a raw-body parser on
// this path because the signature covers the exact bytes sent. Fails closed:
// with no signing secret configured nothing is accepted, so nobody can post
// fake opens, clicks, bounces or complaints. A processing error returns 500
// so Svix retries; the handlers are idempotent.
router.post('/webhook', (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SIGNING_SECRET is not set; rejecting event');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Expected application/json' });

  const check = verifySvix(secret, req.body, req.headers);
  if (!check.ok) {
    console.warn('[resend-webhook] rejected:', check.reason);
    return res.status(check.status === 500 ? 500 : 401).json({ error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  try {
    const result = recordEmailEvent(event);
    if (result !== 'ignored') console.log(`[resend-webhook] ${event.type} -> ${result}`);
  } catch (e) {
    console.error('[resend-webhook] processing failed:', e.message);
    return res.status(500).json({ error: 'Processing failed' });
  }
  res.json({ received: true });
});

export default router;
