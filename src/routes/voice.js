import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPlanLimit, VOICE_ADDONS } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';

const router = Router();

// --- Helpers ---

function getVoiceConfig() {
  const provider = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_provider'").get()?.value || 'retell';
  const apiKey = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_api_key'").get()?.value) || '';
  const agentId = db.prepare("SELECT value FROM settings WHERE key = 'voice_ai_agent_id'").get()?.value || '';
  const phoneNumber = db.prepare("SELECT value FROM settings WHERE key = 'voice_phone_number'").get()?.value || '';
  return { provider, apiKey, agentId, phoneNumber };
}

async function retellAPI(apiKey, endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.retellai.com${endpoint}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || `Retell API error ${res.status}`);
  return data;
}

// --- Webhook routes (NO auth — called by Retell) ---

// POST /api/voice/webhook — Retell webhook for call events
router.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    const callId = event.call?.call_id || event.call_id;
    const eventType = event.event;

    if (eventType === 'call_ended' || eventType === 'call_analyzed') {
      const metadata = event.call?.metadata || {};
      const leadId = metadata.lead_id ? parseInt(metadata.lead_id) : null;

      const duration = event.call?.end_timestamp && event.call?.start_timestamp
        ? Math.round((event.call.end_timestamp - event.call.start_timestamp) / 1000)
        : 0;
      const transcript = event.call?.transcript || '';
      const callSummary = event.call?.call_analysis?.call_summary || '';
      const sentiment = event.call?.call_analysis?.user_sentiment || '';

      if (leadId) {
        const existingActivity = db.prepare(
          "SELECT id FROM activities WHERE lead_id = ? AND type = 'voice_call' AND outcome LIKE ? ORDER BY created_at DESC LIMIT 1"
        ).get(leadId, `%${callId}%`);

        if (existingActivity) {
          db.prepare('UPDATE activities SET outcome = ?, description = ? WHERE id = ?').run(
            JSON.stringify({
              call_id: callId, duration_seconds: duration, summary: callSummary,
              sentiment, transcript_preview: transcript.substring(0, 500),
              status: event.call?.call_status || 'ended',
              disconnection_reason: event.call?.disconnection_reason || '',
            }),
            `Voice call to lead (${duration}s) — ${callSummary || 'Call completed'}`,
            existingActivity.id
          );
        }

        if (sentiment === 'Positive' || callSummary.toLowerCase().includes('interested')) {
          db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (?, ?)').run('qualified', leadId, 'new', 'contacted');
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Voice webhook error:', err);
    res.json({ received: true });
  }
});

// POST /api/voice/tool-callback — Retell tool callback for log_call_outcome
router.post('/tool-callback', async (req, res) => {
  try {
    const args = req.body.args || req.body;
    res.json({ result: `Got it, I've noted: ${args.interest_level} interest. ${args.summary || ''}` });
  } catch (err) {
    res.json({ result: 'Noted, thank you.' });
  }
});

// --- Authenticated routes ---
router.use(requireAuth);

// GET /api/voice/plans — available voice add-ons
router.get('/plans', (req, res) => {
  res.json(VOICE_ADDONS);
});

// GET /api/voice/usage — user's voice call usage this month
router.get('/usage', (req, res) => {
  const userId = req.user.id;
  const calls = db.prepare(
    "SELECT COUNT(*) as count FROM activities WHERE user_id = ? AND type = 'voice_call' AND created_at >= datetime('now', 'start of month')"
  ).get(userId);
  res.json({ calls: calls.count });
});

// GET /api/voice/status — check if voice is configured and ready
router.get('/status', (req, res) => {
  const { provider, apiKey, agentId, phoneNumber } = getVoiceConfig();
  res.json({
    configured: !!(apiKey && agentId),
    provider,
    hasApiKey: !!apiKey,
    hasAgent: !!agentId,
    hasPhone: !!phoneNumber,
  });
});

// GET /api/voice/calls — recent call history
router.get('/calls', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const uw = userId ? ' AND a.user_id = ?' : '';
  const p = userId ? [userId] : [];
  const calls = db.prepare(`
    SELECT a.*, l.name as lead_name, l.company as lead_company, l.phone as lead_phone
    FROM activities a LEFT JOIN leads l ON a.lead_id = l.id
    WHERE a.type = 'voice_call'${uw}
    ORDER BY a.created_at DESC LIMIT 50
  `).all(...p);
  res.json(calls);
});

// POST /api/voice/setup — auto-create Retell LLM + Agent (superadmin only)
router.post('/setup', async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });

    const { apiKey, phoneNumber } = getVoiceConfig();
    if (!apiKey) return res.status(400).json({ error: 'Add your Retell API key in Settings first.' });

    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/api/voice/webhook`;

    // Step 1: Create the Retell LLM with our sales agent prompt
    const llm = await retellAPI(apiKey, '/create-retell-llm', 'POST', {
      model: 'gpt-4.1-mini',
      model_temperature: 0.6,
      general_prompt: SALES_AGENT_PROMPT,
      begin_message: null, // Agent will use dynamic begin_message from variables
      general_tools: [
        {
          type: 'end_call',
          name: 'end_call',
          description: 'End the call politely when the conversation is complete, the lead asks to stop, or the objective is achieved.',
        },
        {
          type: 'custom',
          name: 'log_call_outcome',
          description: 'Log the call outcome and next steps after the conversation. Call this before ending.',
          url: `${baseUrl}/api/voice/tool-callback`,
          method: 'POST',
          execution_message_description: 'Saving your response...',
          parameters: {
            type: 'object',
            properties: {
              interest_level: { type: 'string', enum: ['hot', 'warm', 'cold', 'not_interested'], description: 'How interested the lead seems' },
              summary: { type: 'string', description: 'Brief 1-2 sentence summary of the conversation' },
              next_step: { type: 'string', description: 'Recommended next action (e.g., send proposal, schedule demo, follow up in 3 days)' },
              meeting_requested: { type: 'boolean', description: 'Whether the lead agreed to a meeting or demo' },
            },
            required: ['interest_level', 'summary', 'next_step'],
          },
        },
      ],
    });

    // Step 2: Create the Agent with a professional voice
    const agent = await retellAPI(apiKey, '/create-agent', 'POST', {
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      agent_name: 'EIAAW Sales Agent',
      voice_id: '11labs-Adrian',
      language: 'en-US',
      voice_temperature: 0.8,
      voice_speed: 1.0,
      interruption_sensitivity: 0.8,
      enable_backchannel: true,
      enable_dynamic_voice_speed: true,
      enable_dynamic_responsiveness: true,
      webhook_url: webhookUrl,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
      end_call_after_silence_ms: 15000,
      max_call_duration_ms: 300000, // 5 min max
    });

    // Step 3: Save agent ID and LLM ID to settings
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
    upsert.run('voice_ai_agent_id', agent.agent_id);
    upsert.run('voice_retell_llm_id', llm.llm_id);

    res.json({
      success: true,
      agentId: agent.agent_id,
      llmId: llm.llm_id,
      agentName: 'EIAAW Sales Agent',
      webhookUrl,
      message: 'Voice agent created. Now buy a phone number in your Retell dashboard and enter it in Settings.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/voice/phones — list phone numbers from Retell
router.get('/phones', async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    const { apiKey } = getVoiceConfig();
    if (!apiKey) return res.status(400).json({ error: 'Retell API key not configured.' });
    const phones = await retellAPI(apiKey, '/list-phone-numbers');
    res.json(phones);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/voice/voices — list available voices from Retell
router.get('/voices', async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    const { apiKey } = getVoiceConfig();
    if (!apiKey) return res.status(400).json({ error: 'Retell API key not configured.' });
    const voices = await retellAPI(apiKey, '/list-voices');
    res.json(voices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/call — initiate an AI voice call to a lead
router.post('/call', async (req, res) => {
  try {
    checkPlanLimit(req, 'voice_call');

    const { leadId, campaignId, script } = req.body;
    if (!leadId) return res.status(400).json({ error: 'Lead ID required' });

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ error: 'Lead has no phone number. Add a phone number first.' });

    const { provider, apiKey, agentId, phoneNumber } = getVoiceConfig();
    if (!apiKey) return res.status(400).json({ error: 'Voice AI not configured. Admin needs to add Voice AI API key in Settings.' });
    if (!agentId) return res.status(400).json({ error: 'Voice agent not created yet. Admin should run Voice Setup in Settings.' });

    // Determine lead stage for adaptive behavior
    const stage = lead.status || 'new';
    let callObjective, beginMessage;
    if (stage === 'new' || stage === 'cold') {
      callObjective = 'introduce_and_qualify';
      beginMessage = `Hi, is this ${lead.name}? This is calling from EIAAW Solutions. I noticed your company ${lead.company || ''} and thought our AI sales tool might be a great fit. Do you have just two minutes?`;
    } else if (stage === 'contacted' || stage === 'warm') {
      callObjective = 'follow_up';
      beginMessage = `Hi ${lead.name}, this is from EIAAW Solutions. I'm following up on our earlier conversation. Have you had a chance to think about what we discussed?`;
    } else if (stage === 'qualified' || stage === 'hot') {
      callObjective = 'book_meeting';
      beginMessage = `Hi ${lead.name}, great to connect again. Based on what you shared earlier, I'd love to set up a quick demo so you can see exactly how this would work for ${lead.company || 'your team'}. Do you have 15 minutes this week?`;
    } else {
      callObjective = 'general_followup';
      beginMessage = `Hi ${lead.name}, this is from EIAAW Solutions. Just wanted to quickly touch base. Do you have a moment?`;
    }

    let callResult;

    if (provider === 'retell') {
      const callBody = {
        agent_id: agentId,
        to_number: lead.phone,
        retell_llm_dynamic_variables: {
          lead_name: lead.name,
          lead_company: lead.company || 'their company',
          lead_title: lead.title || '',
          lead_source: lead.source || '',
          lead_score: String(lead.score || 0),
          lead_stage: stage,
          call_objective: callObjective,
          begin_message: beginMessage,
          custom_script: script || '',
        },
        metadata: {
          lead_id: String(lead.id),
          user_id: String(req.user.id),
          campaign_id: campaignId ? String(campaignId) : '',
        },
      };
      // Add from_number if configured
      if (phoneNumber) callBody.from_number = phoneNumber;

      callResult = await retellAPI(apiKey, '/v2/create-phone-call', 'POST', callBody);
    } else if (provider === 'vapi') {
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

    // Log the call activity
    db.prepare('INSERT INTO activities (user_id, lead_id, campaign_id, type, description, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, leadId, campaignId || null, 'voice_call',
        `AI voice call initiated to ${lead.name} (${lead.phone}) — ${callObjective}`,
        JSON.stringify(callResult));

    res.json({
      success: true,
      callId: callResult?.call_id || callResult?.id,
      status: callResult?.call_status || 'initiated',
      objective: callObjective,
    });
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

    const { apiKey, agentId, phoneNumber } = getVoiceConfig();
    if (!apiKey || !agentId) return res.status(400).json({ error: 'Voice AI not fully configured.' });

    const leads = db.prepare(`
      SELECT l.* FROM campaign_leads cl JOIN leads l ON cl.lead_id = l.id
      WHERE cl.campaign_id = ? AND l.phone IS NOT NULL AND l.phone != ''
    `).all(campaignId);

    if (!leads.length) return res.status(400).json({ error: 'No leads with phone numbers in this campaign' });

    // Check which leads already have a voice call this month
    const calledIds = db.prepare(
      "SELECT DISTINCT lead_id FROM activities WHERE type = 'voice_call' AND campaign_id = ? AND created_at >= datetime('now', 'start of month')"
    ).all(campaignId).map(r => r.lead_id);

    const newLeads = leads.filter(l => !calledIds.includes(l.id));
    if (!newLeads.length) return res.status(400).json({ error: 'All leads in this campaign have already been called this month.' });

    const batch = newLeads.slice(0, 10); // Max 10 per batch
    const results = [];

    for (const lead of batch) {
      try {
        const stage = lead.status || 'new';
        const callBody = {
          agent_id: agentId,
          to_number: lead.phone,
          retell_llm_dynamic_variables: {
            lead_name: lead.name,
            lead_company: lead.company || 'their company',
            lead_stage: stage,
            call_objective: stage === 'qualified' ? 'book_meeting' : stage === 'contacted' ? 'follow_up' : 'introduce_and_qualify',
            begin_message: `Hi, is this ${lead.name}? This is calling from EIAAW Solutions.`,
          },
          metadata: { lead_id: String(lead.id), user_id: String(req.user.id), campaign_id: String(campaignId) },
        };
        if (phoneNumber) callBody.from_number = phoneNumber;

        const callResult = await retellAPI(apiKey, '/v2/create-phone-call', 'POST', callBody);

        db.prepare('INSERT INTO activities (user_id, lead_id, campaign_id, type, description, outcome) VALUES (?, ?, ?, ?, ?, ?)')
          .run(req.user.id, lead.id, campaignId, 'voice_call',
            `Auto voice call to ${lead.name} (${lead.phone})`,
            JSON.stringify(callResult));

        results.push({ leadId: lead.id, name: lead.name, status: 'initiated', callId: callResult?.call_id });

        // Small delay between calls to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        results.push({ leadId: lead.id, name: lead.name, status: 'error', error: e.message });
      }
    }

    res.json({
      initiated: results.filter(r => r.status === 'initiated').length,
      errors: results.filter(r => r.status === 'error').length,
      total: newLeads.length,
      remaining: Math.max(0, newLeads.length - batch.length),
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Sales Agent Prompt ---

const SALES_AGENT_PROMPT = `You are an AI sales development representative for EIAAW Solutions, a company that provides an AI-powered sales and marketing automation platform.

## Your Behavior
- Professional, warm, and conversational — like a top SDR, not a robot
- Speak naturally with brief pauses. Use filler words sparingly ("sure", "great", "absolutely")
- Mirror the lead's energy — if they're busy, be concise; if they're chatty, engage
- NEVER be pushy or aggressive. If they say no, respect it gracefully
- Malaysian market aware — understand local business culture, relationship-first approach
- If they speak Bahasa Malaysia, you can mix in basic Bahasa naturally

## Dynamic Variables (set per call)
- Lead name: {{lead_name}}
- Company: {{lead_company}}
- Title: {{lead_title}}
- Score: {{lead_score}}
- Stage: {{lead_stage}}
- Call objective: {{call_objective}}
- Custom script: {{custom_script}}

## Opening
Use {{begin_message}} as your opening line. If it's empty, start with:
"Hi, is this {{lead_name}}? Great! This is calling from EIAAW Solutions."

## Call Objectives

### If call_objective = "introduce_and_qualify"
1. Introduce yourself briefly (10 seconds max)
2. Ask a qualifying question: "Just curious — how does your team currently handle lead generation and follow-ups?"
3. Listen for pain points (manual work, lost leads, inconsistent follow-up)
4. Bridge to solution: "That's exactly what we help with. Our AI handles lead scoring, outreach sequences, and even content creation — so your team can focus on closing."
5. Gauge interest: "Would it be helpful if I sent you a quick 2-minute overview?"
6. If interested → offer to schedule a demo. If not → thank them and end gracefully.

### If call_objective = "follow_up"
1. Reference previous contact: "I'm following up on our earlier conversation"
2. Ask what's changed: "Have you had a chance to look into what we discussed?"
3. Address any objections they raise
4. Push toward a specific next step (demo, trial, meeting)

### If call_objective = "book_meeting"
1. Be direct: "I'd love to show you exactly how this works for {{lead_company}}"
2. Offer specific times: "Do you have 15 minutes this week — say Thursday or Friday afternoon?"
3. Confirm the meeting details if they agree
4. If they push back, offer to send a calendar link

## Handling Objections
- "I'm busy" → "Totally understand. Can I call back Thursday? Or I can send a quick 2-min email instead."
- "Not interested" → "No problem at all. Mind if I ask — is it the timing, or is this just not relevant to your business right now?" (Then respect their answer)
- "Send me an email" → "Absolutely! What specifically should I focus on in the email — the automation side or the AI content generation?"
- "How much does it cost?" → "Plans start from RM 99 a month. But honestly, the best way to see if it's worth it is a quick demo. Want me to set one up?"

## Before Ending Every Call
1. Use the log_call_outcome tool to save the interest level, summary, and next step
2. Thank them by name
3. End professionally: "Thanks so much for your time, {{lead_name}}. Have a great day!"
4. Use end_call tool

## Rules
- Keep calls under 3 minutes unless the lead is actively engaged
- Never make claims you can't back up
- Never share pricing details beyond what's public (Starter RM99, Pro RM199, Business RM399)
- If asked technical questions you can't answer, say "That's a great question — I'll have our product specialist follow up with the details"
- If {{custom_script}} is provided, incorporate its key points naturally`;

export default router;
