import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPlanLimit, VOICE_ADDONS } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';

const router = Router();
router.use(requireAuth);

// GET /api/voice/plans — available voice add-ons
router.get('/plans', (req, res) => {
  res.json(VOICE_ADDONS);
});

// GET /api/voice/usage — user's voice call usage this month
router.get('/usage', (req, res) => {
  const userId = req.user.id;
  const usage = db.prepare(
    "SELECT COUNT(*) as calls, COALESCE(SUM(CAST(outcome AS REAL)), 0) as minutes FROM activities WHERE user_id = ? AND type = 'voice_call' AND created_at >= datetime('now', 'start of month')"
  ).get(userId);
  res.json(usage);
});

// POST /api/voice/call — initiate an AI voice call to a lead
router.post('/call', async (req, res) => {
  try {
    checkPlanLimit(req, 'voice_call');

    const { leadId, campaignId, script } = req.body;
    if (!leadId) return res.status(400).json({ error: 'Lead ID required' });

    // Get lead details (full, not masked — server-side only)
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number' });

    // Get voice AI config
    const provider = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_provider'").get()?.value || 'retell';
    const apiKey = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_api_key'").get()?.value) || '';
    const agentId = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_agent_id'").get()?.value || '';

    if (!apiKey) {
      return res.status(400).json({ error: 'Voice AI not configured. Admin needs to add Voice AI API key in Settings.' });
    }

    let callResult;

    if (provider === 'retell') {
      // Retell AI integration
      const response = await fetch('https://api.retellai.com/v2/create-phone-call', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          customer_number: lead.phone,
          metadata: {
            lead_name: lead.name,
            lead_company: lead.company,
            campaign_id: campaignId,
            script: script || `Hi, I'm calling from EIAAW Solutions about our AI sales tool. Is this ${lead.name}?`,
          },
        }),
      });
      callResult = await response.json();
    } else if (provider === 'vapi') {
      // Vapi integration
      const response = await fetch('https://api.vapi.ai/call/phone', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: agentId,
          customer: { number: lead.phone, name: lead.name },
          phoneNumberId: req.body.phoneNumberId,
        }),
      });
      callResult = await response.json();
    }

    // Log the call
    db.prepare('INSERT INTO activities (user_id, lead_id, campaign_id, type, description, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, leadId, campaignId || null, 'ai_action',
        `AI voice call to ${lead.name} (${lead.phone})`,
        JSON.stringify(callResult));

    res.json({ success: true, callId: callResult?.call_id || callResult?.id, status: 'initiated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/auto-call — batch AI calls to all leads in a campaign
router.post('/auto-call', async (req, res) => {
  try {
    checkPlanLimit(req, 'voice_call');

    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID required' });

    const leads = db.prepare(`
      SELECT l.* FROM campaign_leads cl JOIN leads l ON cl.lead_id = l.id
      WHERE cl.campaign_id = ? AND l.phone IS NOT NULL AND l.phone != ''
    `).all(campaignId);

    if (!leads.length) return res.status(400).json({ error: 'No leads with phone numbers in this campaign' });

    const results = [];
    for (const lead of leads.slice(0, 20)) { // Max 20 calls per batch
      try {
        // Queue the call (don't actually call in batch — use outreach_queue)
        db.prepare(`INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, subject, message, goal, delay_days, status)
          VALUES (?, ?, 1, 'ai_action', ?, ?, 'AI voice outreach', 0, 'pending')`)
          .run(campaignId, lead.id, `Call to ${lead.name}`, `AI voice call to ${lead.name} at ${lead.company || 'their company'}`);
        results.push({ leadId: lead.id, name: lead.name, status: 'queued' });
      } catch (e) {
        results.push({ leadId: lead.id, name: lead.name, status: 'error', error: e.message });
      }
    }

    res.json({ queued: results.filter(r => r.status === 'queued').length, total: leads.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
