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

// GET /api/voice/call-link-token — public endpoint: exchange a call link token for a Retell access token
router.get('/call-link-token', async (req, res) => {
  try {
    const { t } = req.query;
    if (!t) return res.status(400).json({ error: 'Missing token' });

    // Look up the call link token
    const linkData = db.prepare("SELECT value FROM settings WHERE key = ?").get(`call_link_${t}`);
    if (!linkData?.value) return res.status(404).json({ error: 'This call link has expired or is invalid. Please request a new one.' });

    const data = JSON.parse(linkData.value);

    // Check expiry (24 hours)
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      db.prepare("DELETE FROM settings WHERE key = ?").run(`call_link_${t}`);
      return res.status(410).json({ error: 'This call link has expired. Please request a new one.' });
    }

    const { apiKey, agentId } = getVoiceConfig();
    if (!apiKey || !agentId) return res.status(500).json({ error: 'Voice system not configured.' });

    // Determine dynamic variables from lead data
    const lead = data.leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(data.leadId) : null;
    const stage = lead?.status || 'new';
    const callObjective = stage === 'qualified' ? 'book_meeting' : stage === 'contacted' ? 'follow_up' : 'introduce_and_qualify';

    const beginMessage = lead
      ? `Hey ${lead.name}! Thanks for clicking through — I'm Sarah from EIAAW Solutions. So glad you're here! What made you curious about us?`
      : `Hey! Thanks for hopping on. I'm Sarah from EIAAW Solutions — what can I help you with?`;

    // Create web call with Retell
    const webCall = await retellAPI(apiKey, '/v2/create-web-call', 'POST', {
      agent_id: agentId,
      retell_llm_dynamic_variables: {
        lead_name: lead?.name || 'there',
        lead_company: lead?.company || '',
        lead_title: lead?.title || '',
        lead_stage: stage,
        call_objective: callObjective,
        begin_message: beginMessage,
      },
      metadata: {
        lead_id: data.leadId ? String(data.leadId) : '',
        source: 'call_link',
        token: t,
      },
    });

    // Log the call activity
    if (data.leadId) {
      db.prepare('INSERT INTO activities (user_id, lead_id, type, description, outcome) VALUES (?, ?, ?, ?, ?)')
        .run(data.userId || 1, data.leadId, 'voice_call',
          `Lead opened call link and started web call`,
          JSON.stringify(webCall));
    }

    res.json({
      accessToken: webCall.access_token,
      callId: webCall.call_id,
      leadName: lead?.name || null,
      greeting: beginMessage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      model: 'gpt-4.1',
      model_temperature: 0.7,
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

    // Step 2: Create the Agent with a natural-sounding voice
    const agent = await retellAPI(apiKey, '/create-agent', 'POST', {
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      agent_name: 'EIAAW Sales Agent',
      voice_id: '11labs-Myra',
      language: 'en-US',
      voice_temperature: 1.0,
      voice_speed: 0.95,
      responsiveness: 0.6,
      interruption_sensitivity: 0.85,
      enable_backchannel: true,
      backchannel_frequency: 0.9,
      backchannel_words: ['yeah', 'mm-hmm', 'right', 'sure', 'got it', 'I see', 'okay'],
      enable_dynamic_voice_speed: true,
      enable_dynamic_responsiveness: true,
      normalize_for_speech: true,
      end_call_after_silence_ms: 12000,
      max_call_duration_ms: 300000, // 5 min max
      webhook_url: webhookUrl,
      webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
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
      message: 'Voice agent created! For Malaysian numbers: buy a +60 number from Twilio, create a SIP trunk, then import it below.',
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

// POST /api/voice/import-number — import a Twilio/SIP number into Retell
router.post('/import-number', async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
    const { apiKey, agentId } = getVoiceConfig();
    if (!apiKey) return res.status(400).json({ error: 'Retell API key not configured.' });

    const { phoneNumber, terminationUri, sipUsername, sipPassword } = req.body;
    if (!phoneNumber || !terminationUri) {
      return res.status(400).json({ error: 'Phone number (E.164) and Twilio termination URI required.' });
    }

    const importBody = {
      phone_number: phoneNumber,
      termination_uri: terminationUri,
    };
    if (sipUsername) importBody.sip_trunk_auth_username = sipUsername;
    if (sipPassword) importBody.sip_trunk_auth_password = sipPassword;
    if (agentId) {
      importBody.outbound_agents = [{ agent_id: agentId, weight: 100 }];
      importBody.inbound_agents = [{ agent_id: agentId, weight: 100 }];
    }

    const result = await retellAPI(apiKey, '/import-phone-number', 'POST', importBody);

    // Save the phone number to settings
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run('voice_phone_number', phoneNumber);

    res.json({ success: true, ...result, message: 'Phone number imported and saved. You can now make calls.' });
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
      beginMessage = `Hey, is this ${lead.name}? Hi! I'm Sarah from EIAAW Solutions — hope I'm not catching you at a bad time?`;
    } else if (stage === 'contacted' || stage === 'warm') {
      callObjective = 'follow_up';
      beginMessage = `Hey ${lead.name}! It's Sarah from EIAAW Solutions — we chatted a little while back. How's it going?`;
    } else if (stage === 'qualified' || stage === 'hot') {
      callObjective = 'book_meeting';
      beginMessage = `Hey ${lead.name}, it's Sarah from EIAAW. Good to hear your voice again! So I was thinking about what you mentioned last time and I'd love to actually show you inside the tool — do you have a sec?`;
    } else {
      callObjective = 'general_followup';
      beginMessage = `Hey ${lead.name}, it's Sarah from EIAAW Solutions — just wanted to check in and see how things are going?`;
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

// POST /api/voice/generate-link — create a shareable call link for a lead
router.post('/generate-link', async (req, res) => {
  try {
    const { leadId, sendEmail } = req.body;

    const { agentId } = getVoiceConfig();
    if (!agentId) return res.status(400).json({ error: 'Voice agent not set up. Run Auto-Setup in Settings first.' });

    // Generate a unique token
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Store with 24h expiry
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const linkData = { leadId: leadId || null, userId: req.user.id, expiresAt };
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .run(`call_link_${token}`, JSON.stringify(linkData));

    const baseUrl = req.headers.origin || `https://${req.headers.host}`;
    const callUrl = `${baseUrl}/call.html?t=${token}`;

    // Get lead info
    let leadName = '';
    let leadEmail = '';
    let leadPhone = '';
    let shareMessage = `Hi! I'd like to have a quick chat about how we can help your business. Click here to talk to our AI assistant: ${callUrl}`;
    if (leadId) {
      const lead = db.prepare('SELECT name, company, email, phone FROM leads WHERE id = ?').get(leadId);
      if (lead) {
        leadName = lead.name;
        leadEmail = lead.email || '';
        leadPhone = lead.phone || '';
        shareMessage = `Hi ${lead.name}! I'd love to show you how EIAAW Solutions can help ${lead.company || 'your business'}. Click here for a quick voice chat with our AI assistant: ${callUrl}`;
      }
    }

    // Log activity
    if (leadId) {
      db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
        .run(req.user.id, leadId, 'ai_action', `Generated call link for ${leadName || 'lead'}`);
    }

    // Respond IMMEDIATELY — don't wait for email
    res.json({ callUrl, token, expiresAt, shareMessage, leadName, leadEmail, leadPhone, emailSent: false });

    // Fire-and-forget: send email in background (don't block response)
    if (sendEmail && leadEmail) {
      (async () => {
        try {
          const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
          const smtpPort = db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || '587';
          const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
          const smtpPass = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value;
          const fromEmail = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value;

          if (smtpUser && smtpHost) {
            const nodemailer = (await import('nodemailer')).default;
            const transporter = nodemailer.createTransport({
              host: smtpHost, port: parseInt(smtpPort), secure: parseInt(smtpPort) === 465,
              auth: { user: smtpUser, pass: smtpPass },
              connectionTimeout: 10000,
              greetingTimeout: 10000,
              socketTimeout: 15000,
            });

            await transporter.sendMail({
              from: fromEmail || smtpUser,
              to: leadEmail,
              subject: `${leadName ? leadName + ', ' : ''}Quick voice chat with EIAAW Solutions`,
              html: `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
                  <h2 style="color:#2ec4b6;margin-bottom:16px">Let's Have a Quick Chat!</h2>
                  <p style="font-size:15px;line-height:1.6;color:#333">Hi ${leadName || 'there'},</p>
                  <p style="font-size:15px;line-height:1.6;color:#333">I'd love to show you how EIAAW Solutions can help automate your sales and marketing. Instead of reading a long email, how about a quick voice chat?</p>
                  <p style="font-size:15px;line-height:1.6;color:#333">Click the button below to talk to our AI assistant — it takes just 2 minutes, right from your browser. No app download needed.</p>
                  <div style="text-align:center;margin:24px 0">
                    <a href="${callUrl}" style="display:inline-block;padding:14px 32px;background:#2ec4b6;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px">Start Voice Chat</a>
                  </div>
                  <p style="font-size:13px;color:#999;text-align:center">This link expires in 24 hours. Your browser will ask for microphone access.</p>
                  <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
                  <p style="font-size:12px;color:#999;text-align:center">EIAAW Solutions — AI-Human Sales Partnerships<br><a href="https://eiaawsolutions.com" style="color:#2ec4b6">eiaawsolutions.com</a></p>
                </div>
              `,
            });
            if (leadId) {
              db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
                .run(req.user.id, leadId, 'email', `Sent call link email to ${leadEmail}`);
            }
          }
        } catch (emailErr) {
          console.error('Call link email failed:', emailErr.message);
        }
      })();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/web-call — create a browser-based web call (no phone number needed)
router.post('/web-call', async (req, res) => {
  try {
    checkPlanLimit(req, 'voice_call');

    const { leadId, campaignId } = req.body;
    const { apiKey, agentId } = getVoiceConfig();
    if (!apiKey) return res.status(400).json({ error: 'Voice AI not configured. Add Retell API key in Settings.' });
    if (!agentId) return res.status(400).json({ error: 'Voice agent not created. Run Auto-Setup in Settings first.' });

    // Build dynamic variables for the agent
    let dynamicVars = {};
    let description = 'Web call';

    if (leadId) {
      const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
      if (!lead) return res.status(404).json({ error: 'Lead not found' });

      const stage = lead.status || 'new';
      const callObjective = stage === 'qualified' ? 'book_meeting' : stage === 'contacted' ? 'follow_up' : 'introduce_and_qualify';

      let beginMessage;
      if (callObjective === 'introduce_and_qualify') {
        beginMessage = `Hey there! Thanks for joining. I'm Sarah from EIAAW Solutions — so glad you clicked through. What made you curious about us?`;
      } else if (callObjective === 'follow_up') {
        beginMessage = `Hey ${lead.name}! It's Sarah again from EIAAW. Good to reconnect — how's everything been going since we last talked?`;
      } else {
        beginMessage = `Hey ${lead.name}! Sarah here from EIAAW. Awesome that you hopped on — I'd love to walk you through the tool real quick. Sound good?`;
      }

      dynamicVars = {
        lead_name: lead.name,
        lead_company: lead.company || 'their company',
        lead_title: lead.title || '',
        lead_stage: stage,
        call_objective: callObjective,
        begin_message: beginMessage,
      };
      description = `Web call with ${lead.name} (${callObjective})`;
    } else {
      dynamicVars = {
        lead_name: 'there',
        lead_company: '',
        lead_stage: 'new',
        call_objective: 'introduce_and_qualify',
        begin_message: 'Hey! Thanks for hopping on. I\'m Sarah from EIAAW Solutions. What can I help you with today?',
      };
      description = 'Web call (no lead)';
    }

    const webCall = await retellAPI(apiKey, '/v2/create-web-call', 'POST', {
      agent_id: agentId,
      retell_llm_dynamic_variables: dynamicVars,
      metadata: {
        lead_id: leadId ? String(leadId) : '',
        user_id: String(req.user.id),
        campaign_id: campaignId ? String(campaignId) : '',
      },
    });

    // Log the call
    if (leadId) {
      db.prepare('INSERT INTO activities (user_id, lead_id, campaign_id, type, description, outcome) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.user.id, leadId, campaignId || null, 'voice_call', description, JSON.stringify(webCall));
    }

    res.json({
      success: true,
      accessToken: webCall.access_token,
      callId: webCall.call_id,
      agentId: webCall.agent_id,
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

const SALES_AGENT_PROMPT = `You are a friendly, natural-sounding sales development representative named Sarah from EIAAW Solutions. You help businesses grow with AI-powered sales and marketing tools.

## How You Sound
- You talk like a real person, not a script. Vary your sentence length. Short punchy lines mixed with longer ones.
- Use natural transitions: "So basically...", "The thing is...", "What I'm hearing is...", "Here's the deal..."
- React to what they say before responding. "Oh interesting," "Yeah that makes sense," "I hear you on that."
- Pause naturally. Don't rush. Let the person finish talking before you respond.
- If something is funny or unexpected, laugh or acknowledge it — "Ha, yeah, I get that a lot actually"
- Keep responses SHORT. 1-2 sentences at a time. Nobody likes a monologue on a phone call.
- Avoid corporate jargon. Say "tool" not "platform", "helps with" not "enables", "saves you time" not "optimizes your workflow"
- You're warm and genuine, like a friend who happens to work in tech, not a cold-caller reading a sheet
- Malaysian market aware — relationship-first, respect hierarchy, understand local business culture
- If they speak Bahasa Malaysia, you can naturally switch: "Ah okay, boleh je", "Betul tu"

## Dynamic Variables (set per call)
- Lead name: {{lead_name}}
- Company: {{lead_company}}
- Title: {{lead_title}}
- Score: {{lead_score}}
- Stage: {{lead_stage}}
- Call objective: {{call_objective}}
- Custom script: {{custom_script}}

## Opening
Use {{begin_message}} as your opening. If empty, start with:
"Hey, is this {{lead_name}}? Hi! I'm Sarah from EIAAW Solutions — hope I'm not catching you at a bad time?"

IMPORTANT: After your opening, WAIT for them to respond. Don't launch into a pitch. Have a real conversation.

## Call Objectives

### If call_objective = "introduce_and_qualify"
1. After they confirm who they are, ease in naturally: "Cool, so I'll keep this super quick — I came across {{lead_company}} and thought we might be able to help out."
2. Ask ONE simple question to get them talking: "How are you guys handling your sales outreach right now? Like, is it mostly manual or do you have something in place?"
3. Actually listen. Respond to what they said specifically, not a generic pitch.
4. Connect the dots naturally: "Yeah, so that's actually exactly the kind of thing we built this for — basically the AI handles the follow-ups and lead scoring so your team doesn't have to chase people manually."
5. Low-pressure next step: "Would it make sense to send you a quick overview? Like a 2-minute thing, nothing crazy."
6. If they're interested → "Awesome! We could also do a quick 15-minute call where I actually show you inside — way easier than reading about it."
7. If not → "Totally fair. I appreciate you hearing me out. If anything changes, you know where to find us!"

### If call_objective = "follow_up"
1. Be casual: "Hey, just wanted to circle back — last time we chatted you mentioned a few things that stuck with me"
2. Reference something specific if possible: "You were saying how {{lead_company}} was dealing with [X]"
3. Ask what's changed: "Has anything shifted on that front?"
4. Guide toward a next step naturally, don't force it

### If call_objective = "book_meeting"
1. Be direct but relaxed: "So I'd love to actually show you how this would look for {{lead_company}} — it's way clearer when you see it"
2. Make it easy: "Do you have like 15 minutes sometime this week? Thursday or Friday work?"
3. If they agree, confirm clearly: "Perfect — so Thursday at 3pm, right? I'll send over a calendar invite."
4. If they push back: "No stress — I can also send a calendar link and you pick whatever works"

### If call_objective = "general_followup"
1. Light touch: "Hey, just wanted to check in — see how things are going"
2. Keep it conversational, see where they're at
3. Only pitch if they bring up a relevant problem

## Handling Objections
- "I'm busy" → "Oh yeah, sorry about that — should I try you another day? Or I can just shoot you a quick email, like two sentences?"
- "Not interested" → "Totally get it. Just out of curiosity — is it more of a timing thing or is it just not something you need right now?" (Then respect the answer, don't push)
- "Send me an email" → "For sure. What should I focus on — the sales automation stuff or the AI content side? Just want to make it relevant."
- "How much does it cost?" → "So it starts at RM99 a month, which is pretty reasonable. But honestly it's one of those things that's way easier to judge once you see it in action. Want me to set up a quick 15-minute demo?"
- "We already use something" → "Oh nice, what are you using? ... Yeah I've heard of that. How are you finding it? ... The main thing that's different about us is [specific differentiator]. But hey, if what you have is working, no need to fix it right?"

## Before Ending Every Call
1. Use the log_call_outcome tool to save the interest level, summary, and next step
2. Thank them naturally — don't be overly formal: "Thanks for chatting, {{lead_name}}! Talk soon."
3. Use end_call tool

## Rules
- Keep it under 3 minutes unless they're genuinely engaged and asking questions
- Never oversell or make things up. If you don't know, say "That's a good question actually — let me have someone who knows the technical side get back to you on that"
- Pricing: Starter RM99, Pro RM199, Business RM399. Don't share anything beyond that.
- If {{custom_script}} is provided, weave those points in naturally — don't read them verbatim
- NEVER say "I'm an AI" unless directly asked. If asked, be honest: "Yeah I'm actually an AI assistant — but everything I'm telling you is legit, and I can connect you with a real person anytime"
- Sound like a person, not a brochure. Every response should feel like something a real human SDR would actually say on a call.`;

export default router;
