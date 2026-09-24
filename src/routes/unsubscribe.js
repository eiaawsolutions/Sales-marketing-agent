import { Router } from 'express';
import db from '../db/index.js';
import { verifyUnsubscribeToken, suppress } from '../services/unsubscribe.js';

const router = Router();

// GET  /unsubscribe/:campaignId/:leadId?t=  confirmation page. It changes
//      nothing, because mail security scanners follow every link in an email.
// POST /unsubscribe/:campaignId/:leadId?t=  opts the recipient out. Serves the
//      page's button and RFC 8058 one-click (List-Unsubscribe-Post) requests.
//
// Pages never show the recipient's address or the sender's details, and an
// invalid token gets the same generic answer whatever the IDs, so the endpoint
// can't be used to enumerate leads.

router.get('/:campaignId/:leadId', (req, res) => {
  const { campaignId, leadId } = req.params;
  const token = String(req.query.t || '');
  if (!verifyUnsubscribeToken(campaignId, leadId, token)) return res.status(400).send(invalidPage());
  res.send(page('Unsubscribe from these emails?',
    `<p>You'll stop receiving marketing emails from this sender.</p>
     <form method="post" action="/unsubscribe/${Number(campaignId)}/${Number(leadId)}?t=${token}">
       <button type="submit" style="background:#1FA896;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;cursor:pointer">Unsubscribe</button>
     </form>`));
});

router.post('/:campaignId/:leadId', (req, res) => {
  const { campaignId, leadId } = req.params;
  if (!verifyUnsubscribeToken(campaignId, leadId, String(req.query.t || ''))) return res.status(400).send(invalidPage());

  try {
    const campaign = db.prepare('SELECT user_id FROM campaigns WHERE id = ?').get(campaignId);
    const lead = campaign && db.prepare('SELECT email FROM leads WHERE id = ? AND user_id = ?').get(leadId, campaign.user_id);
    if (lead?.email) {
      suppress({ userId: campaign.user_id, email: lead.email, reason: 'unsubscribe', campaignId: Number(campaignId), leadId: Number(leadId) });
      db.prepare("INSERT INTO activities (user_id, lead_id, campaign_id, type, description) VALUES (?, ?, ?, 'email', 'Unsubscribed from outreach emails')")
        .run(campaign.user_id, leadId, campaignId);
    }
    // A valid link whose campaign or lead is already deleted gets the same
    // answer: nothing is left that could email them.
  } catch (err) {
    console.error('[unsubscribe] failed:', err.message);
    return res.status(500).send(page('Something went wrong', '<p>Please try the link again in a moment.</p>'));
  }
  res.send(page("You're unsubscribed", "<p>You won't receive further marketing emails from this sender.</p>"));
});

function invalidPage() {
  return page('This link is not valid', '<p>Please use the unsubscribe link from the most recent email you received.</p>');
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title></head>
<body style="margin:0;background:#FAF7F0;font-family:Arial,Helvetica,sans-serif;color:#1a2a2e">
<main style="max-width:460px;margin:12vh auto;padding:32px 24px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
<h1 style="font-size:22px;margin:0 0 12px">${title}</h1>${body}</main></body></html>`;
}

export default router;
