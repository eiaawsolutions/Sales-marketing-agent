import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { checkPlanLimit, VOICE_ADDONS } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';
import { sendEmail } from '../utils/email.js';

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

        // Check if a meeting was booked during the call (from call summary)
        if (callSummary && (callSummary.toLowerCase().includes('meeting booked') || callSummary.toLowerCase().includes('demo scheduled') || callSummary.toLowerCase().includes('agreed to meet'))) {
          const existingAppt = db.prepare('SELECT id FROM appointments WHERE call_id = ?').get(callId);
          if (!existingAppt) {
            // Create a placeholder appointment — the tool-callback may have already created one
            const userId = metadata.user_id ? parseInt(metadata.user_id) : 1;
            const lead = db.prepare('SELECT name FROM leads WHERE id = ?').get(leadId);
            db.prepare(
              `INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, type, notes, call_id, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(leadId, userId, `Follow-up with ${lead?.name || 'Lead'}`,
              new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // Default 3 days out
              15, 'demo', `Auto-created from voice call. Summary: ${callSummary}`, callId, 'scheduled');
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Voice webhook error:', err);
    res.json({ received: true });
  }
});

// POST /api/voice/tool-callback — Retell tool callback dispatcher
router.post('/tool-callback', async (req, res) => {
  try {
    // Log the full payload for debugging
    console.log('[tool-callback] Full payload:', JSON.stringify(req.body, null, 2));

    // Retell sends: { tool_call_id, name, args, call } or { tool_name, arguments, call_id, metadata }
    const toolName = req.body.name || req.body.tool_name || req.body.tool_call_name || '';
    const args = req.body.args || req.body.arguments || {};
    const callId = req.body.call_id || req.body.call?.call_id || '';
    const metadata = req.body.call?.metadata || req.body.metadata || {};
    const leadId = metadata.lead_id ? parseInt(metadata.lead_id) : null;
    const userId = metadata.user_id ? parseInt(metadata.user_id) : 1;

    console.log(`[tool-callback] Tool: "${toolName}", Lead: ${leadId}, Args:`, JSON.stringify(args));

    if (toolName === 'schedule_meeting') {
      return handleScheduleMeeting(args, callId, leadId, userId, res);
    }
    if (toolName === 'send_overview') {
      return handleSendOverview(args, callId, leadId, userId, res);
    }
    if (toolName === 'send_demo_link') {
      return handleSendDemoLink(args, callId, leadId, userId, res);
    }

    // Default: log_call_outcome
    let apptMsg = '';
    if (args.meeting_requested && leadId) {
      const meetingTime = args.meeting_time || args.next_step || '';
      const scheduled = parseMeetingTime(meetingTime);
      if (scheduled) {
        const lead = db.prepare('SELECT name, company FROM leads WHERE id = ?').get(leadId);
        db.prepare(
          `INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, type, notes, call_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(leadId, userId, `Demo with ${lead?.name || 'Lead'}`, scheduled.toISOString(), 15, 'demo',
          args.summary || '', callId);
        db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
          .run(userId, leadId, 'meeting', `Meeting booked via voice call: ${meetingTime}`);
        apptMsg = ' Meeting has been scheduled.';
      }
    }

    // Update lead status based on interest
    if (leadId && args.interest_level) {
      if (args.interest_level === 'hot') {
        db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (?, ?, ?)').run('qualified', leadId, 'new', 'contacted', 'cold');
      } else if (args.interest_level === 'warm') {
        db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (?, ?)').run('contacted', leadId, 'new', 'cold');
      }
    }

    res.json({ result: `Got it, I've noted: ${args.interest_level} interest. ${args.summary || ''}${apptMsg}` });
  } catch (err) {
    console.error('Tool callback error:', err);
    res.json({ result: 'Noted, thank you.' });
  }
});

// --- Tool handlers ---

async function handleScheduleMeeting(args, callId, leadId, userId, res) {
  const { date_time, duration, meeting_type, notes } = args;
  const scheduled = parseMeetingTime(date_time);
  if (!scheduled) {
    return res.json({ result: "I wasn't able to parse that time. Could you confirm the date and time again?" });
  }

  const lead = leadId ? db.prepare('SELECT name, company, email FROM leads WHERE id = ?').get(leadId) : null;
  const title = `${meeting_type === 'demo' ? 'Demo' : 'Meeting'} with ${lead?.name || 'Lead'}`;

  const result = db.prepare(
    `INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, type, notes, call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(leadId, userId, title, scheduled.toISOString(), parseInt(duration) || 15, meeting_type || 'demo', notes || '', callId);

  if (leadId) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(userId, leadId, 'meeting', `Meeting booked via voice call: ${title}`);
  }

  // Fire-and-forget: send calendar invite if lead has email
  if (lead?.email) {
    sendCalendarInvite(result.lastInsertRowid, lead, scheduled, title, parseInt(duration) || 15).catch(err =>
      console.error('Calendar invite send error:', err.message)
    );
  }

  const dateStr = scheduled.toLocaleDateString('en-MY', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const timeStr = scheduled.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
  res.json({ result: `Perfect, I've booked that for ${dateStr} at ${timeStr}. ${lead?.email ? "I'm sending a calendar invite to their email now." : 'All set!'}` });
}

async function handleSendOverview(args, callId, leadId, userId, res) {
  const lead = leadId ? db.prepare('SELECT name, email, company FROM leads WHERE id = ?').get(leadId) : null;
  if (!lead?.email) {
    return res.json({ result: "I don't have their email on file. Could you ask for their email address so I can send it?" });
  }

  // Fire-and-forget
  sendProductOverviewEmail(lead).catch(err => console.error('Overview email error:', err.message));

  if (leadId) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(userId, leadId, 'email', `Sent product overview email to ${lead.email}`);
  }

  res.json({ result: `Done! I've just sent a quick overview to ${lead.email}. They should see it in their inbox shortly.` });
}

async function handleSendDemoLink(args, callId, leadId, userId, res) {
  const lead = leadId ? db.prepare('SELECT name, email, company FROM leads WHERE id = ?').get(leadId) : null;
  if (!lead?.email) {
    return res.json({ result: "I don't have their email. Ask for their email so I can send the demo link." });
  }

  const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'app_base_url'").get()?.value || '';
  const demoToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run(`demo_link_${demoToken}`, JSON.stringify({ leadId, userId, expiresAt }));

  // Fire-and-forget
  sendDemoLinkEmail(lead, demoToken, baseUrl).catch(err => console.error('Demo link email error:', err.message));

  if (leadId) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(userId, leadId, 'email', `Sent interactive demo link to ${lead.email}`);
  }

  res.json({ result: `I've sent an interactive demo link to ${lead.email}. It's a self-guided walkthrough they can explore at their own pace.` });
}

// --- Email helpers ---

async function sendCalendarInvite(apptId, lead, scheduled, title, duration) {
  const end = new Date(scheduled.getTime() + duration * 60000);
  const now = new Date();
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const icsContent = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EIAAW Solutions//SalesAgent//EN',
    'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:appt-${apptId}@eiaaw.com`, `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(scheduled)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${title}`, `ATTENDEE;CN=${lead.name}:mailto:${lead.email}`,
    'ORGANIZER;CN=EIAAW Solutions:mailto:noreply@eiaaw.com',
    'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Meeting in 15 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');

  const dateStr = scheduled.toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = scheduled.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });

  const nodemailer = (await import('nodemailer')).default;
  const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
  const smtpPort = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || '587');
  const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
  const smtpPass = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value) || '';
  const fromEmail = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value;
  if (!smtpUser) return;

  const transporter = nodemailer.createTransport({
    host: smtpHost, port: smtpPort, secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });

  await transporter.sendMail({
    from: fromEmail || smtpUser, to: lead.email,
    subject: `Meeting Confirmed: ${title} — ${dateStr}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#2ec4b6">You're Booked!</h2>
        <p>Hi ${lead.name},</p>
        <p>Your meeting with EIAAW Solutions is confirmed:</p>
        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:4px 0"><strong>Date:</strong> ${dateStr}</p>
          <p style="margin:4px 0"><strong>Time:</strong> ${timeStr}</p>
          <p style="margin:4px 0"><strong>Duration:</strong> ${duration} minutes</p>
        </div>
        <p style="font-size:14px;color:#666">A calendar invite is attached — add it to your calendar!</p>
        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="font-size:12px;color:#999;text-align:center">EIAAW Solutions — AI-Human Sales Partnerships</p>
      </div>`,
    icalEvent: { filename: 'invite.ics', method: 'REQUEST', content: icsContent },
  });
}

async function sendProductOverviewEmail(lead) {
  await sendEmail({
    to: lead.email,
    subject: `${lead.name}, here's the quick overview I mentioned`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px">
        <h2 style="color:#2ec4b6;margin-bottom:4px">EIAAW SalesAgent</h2>
        <p style="color:#999;margin-top:0;font-size:13px">AI-Powered Sales & Marketing Automation</p>

        <p>Hi ${lead.name},</p>
        <p>Thanks for chatting! As promised, here's a quick rundown of what EIAAW SalesAgent does:</p>

        <div style="margin:20px 0">
          <div style="padding:12px 0;border-bottom:1px solid #eee">
            <strong style="color:#2ec4b6">1. AI Lead Scoring & Qualification</strong>
            <p style="margin:4px 0;font-size:14px;color:#555">Every lead gets scored 0-100 automatically. Our AI uses the BANT framework to tell you who's ready to buy.</p>
          </div>
          <div style="padding:12px 0;border-bottom:1px solid #eee">
            <strong style="color:#2ec4b6">2. Smart Outreach Sequences</strong>
            <p style="margin:4px 0;font-size:14px;color:#555">AI writes personalized email sequences, follow-ups, and outreach plans — multi-step, multi-channel.</p>
          </div>
          <div style="padding:12px 0;border-bottom:1px solid #eee">
            <strong style="color:#2ec4b6">3. AI Content Creation</strong>
            <p style="margin:4px 0;font-size:14px;color:#555">Generate social posts, ad copy, email campaigns, blog outlines, and SEO keywords — all from a single prompt.</p>
          </div>
          <div style="padding:12px 0;border-bottom:1px solid #eee">
            <strong style="color:#2ec4b6">4. Visual Sales Pipeline</strong>
            <p style="margin:4px 0;font-size:14px;color:#555">Drag-and-drop pipeline board. AI analyzes deal health, forecasts revenue, and flags at-risk deals.</p>
          </div>
          <div style="padding:12px 0;border-bottom:1px solid #eee">
            <strong style="color:#2ec4b6">5. AI Voice Calling</strong>
            <p style="margin:4px 0;font-size:14px;color:#555">AI makes calls on your behalf — introduces, qualifies, follows up, and books meetings. You get the transcript and next steps.</p>
          </div>
          <div style="padding:12px 0">
            <strong style="color:#2ec4b6">6. Campaign Management</strong>
            <p style="margin:4px 0;font-size:14px;color:#555">Run email and social campaigns with open/click tracking. AI optimizes messaging per lead.</p>
          </div>
        </div>

        <div style="background:linear-gradient(135deg,#0a1628,#1a2a45);border-radius:12px;padding:20px;text-align:center;margin:20px 0">
          <p style="color:#fff;margin:0 0 4px;font-size:15px">Plans start from <strong style="color:#2ec4b6">RM 99/month</strong></p>
          <p style="color:#aaa;margin:0;font-size:13px">Starter • Pro (RM199) • Business (RM399)</p>
        </div>

        <p style="font-size:14px;color:#555">Want to see it in action? Just reply to this email and we'll set up a quick 15-minute demo.</p>

        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="font-size:12px;color:#999;text-align:center">EIAAW Solutions — AI-Human Sales Partnerships</p>
      </div>`,
  });
}

async function sendDemoLinkEmail(lead, token, baseUrl) {
  const demoUrl = baseUrl ? `${baseUrl}/demo.html?t=${token}` : `https://eiaawsolutions.com/demo?t=${token}`;
  await sendEmail({
    to: lead.email,
    subject: `${lead.name}, explore EIAAW SalesAgent at your own pace`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#2ec4b6;margin-bottom:16px">Your Interactive Demo</h2>
        <p>Hi ${lead.name},</p>
        <p>Here's your personal demo link — take a self-guided tour of everything EIAAW SalesAgent can do for ${lead.company || 'your business'}.</p>
        <div style="text-align:center;margin:24px 0">
          <a href="${demoUrl}" style="display:inline-block;padding:14px 32px;background:#2ec4b6;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px">Start Interactive Demo</a>
        </div>
        <p style="font-size:14px;color:#666">This link is valid for 7 days. No signup needed — just click and explore.</p>
        <p style="font-size:14px;color:#666">After exploring, if you want a live walkthrough with a real person, just reply to this email!</p>
        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="font-size:12px;color:#999;text-align:center">EIAAW Solutions — AI-Human Sales Partnerships</p>
      </div>`,
  });
}

// --- Date parser for meeting times from voice ---
// All times are interpreted as Malaysian time (UTC+8) since leads and users are in Malaysia.
// We store as ISO string with the correct UTC offset applied.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8

function nowInMYT() {
  const utc = new Date();
  return new Date(utc.getTime() + MYT_OFFSET_MS);
}

function parseMeetingTime(text) {
  if (!text) return null;

  // Try direct ISO parse first (already has timezone info)
  const direct = new Date(text);
  if (!isNaN(direct.getTime()) && direct > new Date()) return direct;

  // Work in Malaysian time
  const myt = nowInMYT();
  const lower = text.toLowerCase();

  // "Thursday at 3pm", "Friday 2:30pm", etc.
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = dayNames.findIndex(d => lower.includes(d));

  // Start with today in MYT
  let targetYear = myt.getUTCFullYear();
  let targetMonth = myt.getUTCMonth();
  let targetDay = myt.getUTCDate();
  let found = false;

  if (lower.includes('tomorrow')) {
    targetDay += 1;
    found = true;
  } else if (lower.includes('today')) {
    found = true;
  } else if (dayMatch >= 0) {
    let daysAhead = dayMatch - myt.getUTCDay();
    if (daysAhead <= 0) daysAhead += 7;
    targetDay += daysAhead;
    found = true;
  } else if (lower.includes('next week')) {
    let daysAhead = 8 - myt.getUTCDay(); // Next Monday
    targetDay += daysAhead;
    found = true;
  }

  if (!found) return null;

  // Extract time: "4pm", "2:30 pm", "15:00", "10am"
  let hour = 10, min = 0; // Default 10am MYT
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    min = parseInt(timeMatch[2] || '0');
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (!ampm && hour < 8) hour += 12; // Assume PM for business hours
  }

  // Build the date in MYT then convert to UTC for storage
  // We construct the MYT time, then subtract 8 hours to get UTC
  const mytDate = new Date(Date.UTC(targetYear, targetMonth, targetDay, hour, min, 0, 0));
  const utcDate = new Date(mytDate.getTime() - MYT_OFFSET_MS);

  return utcDate > new Date() ? utcDate : null;
}

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
      ? `Hey ${lead.name}! Thanks for clicking through — I'm Sarah from E-I-A-A-W A.I. Sales Agent. So glad you're here! What made you curious about us?`
      : `Hey! Thanks for hopping on. I'm Sarah from E-I-A-A-W A.I. Sales Agent — what can I help you with?`;

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
          execution_message_description: 'Saving your notes...',
          parameters: {
            type: 'object',
            properties: {
              interest_level: { type: 'string', enum: ['hot', 'warm', 'cold', 'not_interested'], description: 'How interested the lead seems' },
              summary: { type: 'string', description: 'Brief 1-2 sentence summary of the conversation' },
              next_step: { type: 'string', description: 'Recommended next action (e.g., send proposal, schedule demo, follow up in 3 days)' },
              meeting_requested: { type: 'boolean', description: 'Whether the lead agreed to a meeting or demo' },
              meeting_time: { type: 'string', description: 'If meeting was booked, the agreed date/time (e.g. "Thursday at 3pm", "next Monday 10am")' },
            },
            required: ['interest_level', 'summary', 'next_step'],
          },
        },
        {
          type: 'custom',
          name: 'schedule_meeting',
          description: 'Book a meeting or demo when the lead agrees to one. Use this immediately when they confirm a time.',
          url: `${baseUrl}/api/voice/tool-callback`,
          method: 'POST',
          execution_message_description: 'Booking that in now...',
          parameters: {
            type: 'object',
            properties: {
              date_time: { type: 'string', description: 'The agreed date and time (e.g. "Thursday at 3pm", "tomorrow 10am", "next Monday 2:30pm")' },
              duration: { type: 'string', description: 'Meeting duration in minutes (default 15)', enum: ['15', '30', '45', '60'] },
              meeting_type: { type: 'string', enum: ['demo', 'call', 'meeting', 'follow_up'], description: 'Type of meeting' },
              notes: { type: 'string', description: 'Any notes about what to cover in the meeting' },
            },
            required: ['date_time'],
          },
        },
        {
          type: 'custom',
          name: 'send_overview',
          description: 'Send a product overview email to the lead. Use when they say "send me info", "tell me more via email", or "send me an overview".',
          url: `${baseUrl}/api/voice/tool-callback`,
          method: 'POST',
          execution_message_description: 'Sending that over now...',
          parameters: {
            type: 'object',
            properties: {
              focus: { type: 'string', description: 'What to focus on in the email', enum: ['general', 'automation', 'content', 'pipeline', 'voice'] },
            },
            required: [],
          },
        },
        {
          type: 'custom',
          name: 'send_demo_link',
          description: 'Send an interactive self-guided demo link to the lead via email. Use when they want to explore on their own or are not ready for a live demo.',
          url: `${baseUrl}/api/voice/tool-callback`,
          method: 'POST',
          execution_message_description: 'Sending the demo link...',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
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
      beginMessage = `Hey, is this ${lead.name}? Hi! I'm Sarah from E-I-A-A-W A.I. Sales Agent — hope I'm not catching you at a bad time?`;
    } else if (stage === 'contacted' || stage === 'warm') {
      callObjective = 'follow_up';
      beginMessage = `Hey ${lead.name}! It's Sarah from E-I-A-A-W A.I. Sales Agent — we chatted a little while back. How's it going?`;
    } else if (stage === 'qualified' || stage === 'hot') {
      callObjective = 'book_meeting';
      beginMessage = `Hey ${lead.name}, it's Sarah from E-I-A-A-W. Good to hear your voice again! So I was thinking about what you mentioned last time and I'd love to actually show you inside the tool — do you have a sec?`;
    } else {
      callObjective = 'general_followup';
      beginMessage = `Hey ${lead.name}, it's Sarah from E-I-A-A-W A.I. Sales Agent — just wanted to check in and see how things are going?`;
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
    const { leadId, sendEmail: sendEmailFlag } = req.body;

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
    if (sendEmailFlag && leadEmail) {
      const userId = req.user.id;
      sendEmail({
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
      }).then(() => {
        if (leadId) {
          db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
            .run(userId, leadId, 'email', `Sent call link email to ${leadEmail}`);
        }
        console.log(`Call link email sent to ${leadEmail}`);
      }).catch(err => {
        console.error('Call link email failed:', err.message);
      });
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
        beginMessage = `Hey there! Thanks for joining. I'm Sarah from E-I-A-A-W A.I. Sales Agent — so glad you clicked through. What made you curious about us?`;
      } else if (callObjective === 'follow_up') {
        beginMessage = `Hey ${lead.name}! It's Sarah again from E-I-A-A-W. Good to reconnect — how's everything been going since we last talked?`;
      } else {
        beginMessage = `Hey ${lead.name}! Sarah here from E-I-A-A-W. Awesome that you hopped on — I'd love to walk you through the tool real quick. Sound good?`;
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
        begin_message: 'Hey! Thanks for hopping on. I\'m Sarah from E-I-A-A-W A.I. Sales Agent. What can I help you with today?',
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
            begin_message: `Hi, is this ${lead.name}? This is Sarah calling from E-I-A-A-W A.I. Sales Agent.`,
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

const SALES_AGENT_PROMPT = `You are a friendly, natural-sounding sales development representative named Sarah from E-I-A-A-W A.I. Sales Agent. You help businesses grow with AI-powered sales and marketing tools.

## Pronunciation
IMPORTANT: The product name "EIAAW" is an acronym. Always pronounce it as individual letters: "E, I, A, A, W". Never say it as one word. Always refer to the product as "E-I-A-A-W A.I. Sales Agent" — not "EIAAW Solutions".

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
"Hey, is this {{lead_name}}? Hi! I'm Sarah from E-I-A-A-W A.I. Sales Agent — hope I'm not catching you at a bad time?"

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
- "Send me an email" / "Send me more info" → "For sure!" Then use the send_overview tool to email them a product overview. Say: "Done, just sent it — check your inbox! It covers the main stuff. Want me to focus on anything specific?"
- "Can I see a demo?" / "Show me how it works" → If they want to explore on their own: use send_demo_link to send a self-guided interactive demo. Say: "I just sent you a link — you can click through and explore everything at your own pace." If they want a live walkthrough with a person: use schedule_meeting to book a demo slot. Say: "Let's set that up! When works for you this week?"
- "How much does it cost?" → "So it starts at RM99 a month, which is pretty reasonable. But honestly it's one of those things that's way easier to judge once you see it in action. Want me to set up a quick 15-minute demo?"
- "We already use something" → "Oh nice, what are you using? ... Yeah I've heard of that. How are you finding it? ... The main thing that's different about us is [specific differentiator]. But hey, if what you have is working, no need to fix it right?"

## Your Tools — USE THEM
You have real tools that actually do things. Don't just promise — execute:

1. **schedule_meeting** — When a lead agrees to a meeting/demo, use this IMMEDIATELY with the date and time they said. It creates a real calendar event and sends them an invite. Don't just say "I'll send a calendar invite" — actually do it.
2. **send_overview** — When they ask for more info or say "send me an email", use this. It sends a beautiful product overview email instantly. Confirm: "Just sent it to your email!"
3. **send_demo_link** — When they want to explore on their own, use this. Sends them a self-guided interactive demo they can click through. Say: "Just sent you a demo link — explore at your own pace!"
4. **log_call_outcome** — Always use before ending. Logs interest level, summary, and next steps.
5. **end_call** — Use after log_call_outcome to end the call.

## Before Ending Every Call
1. If a meeting was booked, confirm the details one more time
2. Use the log_call_outcome tool to save the interest level, summary, next step, and meeting_time if applicable
3. Thank them naturally — don't be overly formal: "Thanks for chatting, {{lead_name}}! Talk soon."
4. Use end_call tool

## Rules
- Keep it under 3 minutes unless they're genuinely engaged and asking questions
- Never oversell or make things up. If you don't know, say "That's a good question actually — let me have someone who knows the technical side get back to you on that"
- Pricing: Starter RM99, Pro RM199, Business RM399. Don't share anything beyond that.
- If {{custom_script}} is provided, weave those points in naturally — don't read them verbatim
- NEVER say "I'm an AI" unless directly asked. If asked, be honest: "Yeah I'm actually an AI assistant — but everything I'm telling you is legit, and I can connect you with a real person anytime"
- Sound like a person, not a brochure. Every response should feel like something a real human SDR would actually say on a call.
- When they agree to something actionable (meeting, email, demo), USE THE TOOL immediately. Don't just say you will — do it on the call so they feel the value.`;

export default router;
