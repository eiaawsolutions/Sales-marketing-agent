import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { sendEmail } from '../utils/email.js';
import { getProfile, senderFor, isHqAccount } from '../services/account-profile.js';

const router = Router();
router.use(requireAuth);

// Meeting location: what the user typed, else the account's own meeting room
// from its brief, else none — the host sends the link. (This used to invent a
// random meet.google.com/xxx-xxxx-xxx code, which is not a real meeting.)
function defaultLocation(userId, typed) {
  const t = typeof typed === 'string' ? typed.trim() : '';
  return t || getProfile(userId).meeting_link || null;
}

// GET /api/appointments — list appointments for current user
router.get('/', (req, res) => {
  const { status, upcoming } = req.query;
  let sql = `SELECT a.*, l.name as lead_name, l.email as lead_email, l.company as lead_company, l.phone as lead_phone
    FROM appointments a LEFT JOIN leads l ON a.lead_id = l.id
    WHERE a.user_id = ?`;
  const params = [req.user.id];

  if (status) {
    sql += ' AND a.status = ?';
    params.push(status);
  }
  if (upcoming === '1') {
    sql += " AND a.scheduled_at >= datetime('now') AND a.status IN ('scheduled','confirmed')";
  }
  sql += ' ORDER BY a.scheduled_at ASC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET /api/appointments/:id — single appointment
router.get('/:id', (req, res) => {
  const row = db.prepare(
    `SELECT a.*, l.name as lead_name, l.email as lead_email, l.company as lead_company, l.phone as lead_phone
     FROM appointments a LEFT JOIN leads l ON a.lead_id = l.id
     WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Appointment not found' });
  res.json(row);
});

// POST /api/appointments — create appointment + auto-send calendar invite to lead
router.post('/', async (req, res) => {
  const { lead_id, title, scheduled_at, duration_minutes, type, notes, location } = req.body;
  if (!title || !scheduled_at) return res.status(400).json({ error: 'Title and scheduled_at required' });

  // The invite below is emailed to the lead: it must be this account's lead.
  if (lead_id && !db.prepare('SELECT 1 FROM leads WHERE id = ? AND user_id = ?').get(lead_id, req.user.id)) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const meetLink = defaultLocation(req.user.id, location);

  const result = db.prepare(
    `INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, type, notes, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(lead_id || null, req.user.id, title, scheduled_at, duration_minutes || 15, type || 'demo', notes || null, meetLink);

  // Log activity if lead linked
  if (lead_id) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(req.user.id, lead_id, 'meeting', `Appointment scheduled: ${title} on ${new Date(scheduled_at).toLocaleString()}`);
  }

  const apptId = result.lastInsertRowid;

  // Auto-send calendar invite to lead (fire-and-forget, same pattern as product overview email)
  if (lead_id) {
    const lead = db.prepare('SELECT name, email, company FROM leads WHERE id = ?').get(lead_id);
    if (lead?.email) {
      sendCalendarInviteEmail({
        apptId, lead, scheduled: new Date(scheduled_at), title, duration: duration_minutes || 15,
        location: meetLink, notes, type, userId: req.user.id, leadId: lead_id,
      }).catch(err => console.error('Auto calendar invite error:', err.message));
    }
  }

  res.json({ id: apptId, success: true, location: meetLink });
});

// PUT /api/appointments/:id — update appointment
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Appointment not found' });

  const { title, scheduled_at, duration_minutes, status, type, notes, location } = req.body;
  db.prepare(
    `UPDATE appointments SET title = ?, scheduled_at = ?, duration_minutes = ?, status = ?, type = ?, notes = ?, location = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  ).run(
    title || existing.title, scheduled_at || existing.scheduled_at,
    duration_minutes || existing.duration_minutes, status || existing.status,
    type || existing.type, notes !== undefined ? notes : existing.notes,
    location !== undefined ? location : existing.location,
    req.params.id, req.user.id
  );

  res.json({ success: true });
});

// DELETE /api/appointments/:id — cancel/delete
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Appointment not found' });

  db.prepare('UPDATE appointments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('cancelled', req.params.id);
  res.json({ success: true });
});

// GET /api/appointments/:id/ics — generate .ics calendar file
router.get('/:id/ics', (req, res) => {
  const appt = db.prepare(
    `SELECT a.*, l.name as lead_name, l.email as lead_email, l.company as lead_company
     FROM appointments a LEFT JOIN leads l ON a.lead_id = l.id
     WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const start = new Date(appt.scheduled_at);
  const end = new Date(start.getTime() + (appt.duration_minutes || 15) * 60000);
  const ics = generateICS({
    id: appt.id, scheduled: start, end, title: appt.title,
    notes: appt.notes, location: appt.location,
    leadName: appt.lead_name, leadEmail: appt.lead_email, host: hostFor(req.user.id),
  });
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="appointment-${appt.id}.ics"`,
  });
  res.send(ics);
});

// POST /api/appointments/:id/send-invite — (re)send .ics email to lead
router.post('/:id/send-invite', async (req, res) => {
  const appt = db.prepare(
    `SELECT a.*, l.name as lead_name, l.email as lead_email, l.company as lead_company
     FROM appointments a LEFT JOIN leads l ON a.lead_id = l.id
     WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.lead_email) return res.status(400).json({ error: 'Lead has no email address' });

  try {
    const meetLink = appt.location || defaultLocation(req.user.id, null);
    if (!appt.location && meetLink) {
      db.prepare('UPDATE appointments SET location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(meetLink, appt.id);
    }

    await sendCalendarInviteEmail({
      apptId: appt.id,
      lead: { name: appt.lead_name, email: appt.lead_email, company: appt.lead_company },
      scheduled: new Date(appt.scheduled_at), title: appt.title, duration: appt.duration_minutes,
      location: meetLink, notes: appt.notes, type: appt.type, userId: req.user.id, leadId: appt.lead_id,
    });

    res.json({ success: true, message: 'Calendar invite sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Shared ICS Generator ---
function generateICS({ id, scheduled, end, title, notes, location, leadName, leadEmail, host }) {
  const now = new Date();
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const description = [location ? `Join: ${location}` : '', notes || ''].filter(Boolean).join('\n\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EIAAW Solutions//SalesAgent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:appt-${id}@eiaawsolutions.com`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(scheduled)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${icsText(title)}`,
    description ? `DESCRIPTION:${icsText(description)}` : '',
    location ? `LOCATION:${icsText(location)}` : '',
    host?.email ? `ORGANIZER;CN=${icsParam(host.name)}:mailto:${host.email}` : '',
    host?.email ? `ATTENDEE;CN=${icsParam(host.name)};ROLE=CHAIR:mailto:${host.email}` : '',
    leadEmail ? `ATTENDEE;CN=${icsParam(leadName)};RSVP=TRUE:mailto:${leadEmail}` : '',
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Meeting in 15 minutes',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

// RFC 5545 §3.3.11: escape TEXT values. Unescaped, a comma, semicolon or
// newline in an AI-written title or note breaks the event in the recipient's
// calendar.
function icsText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Parameter values (CN=…) cannot carry quotes, colons or semicolons unquoted.
function icsParam(value) {
  return String(value || '').replace(/["\r\n]/g, '').replace(/[;:,]/g, ' ').trim();
}

function htmlText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The person a meeting is with: the account's sender and the inbox where they
// want replies (falling back to the login email).
function hostFor(userId) {
  const p = getProfile(userId);
  const email = p.reply_to_email || db.prepare('SELECT email FROM users WHERE id = ?').get(userId)?.email || null;
  if (isHqAccount(userId) && !p.business_name) return { name: 'EIAAW Solutions', business: 'EIAAW Solutions', email };
  return { name: p.sender_name || p.business_name || 'Your host', business: p.business_name || p.sender_name || '', email };
}

// --- Shared calendar invite email sender (used by auto-send, manual send-invite and the voice agent) ---
// The prospect gets the meeting details only. `notes` (e.g. the voice
// assistant's Need/Budget/Authority/Timeline summary) are internal: they go in
// the host's copy, never to the prospect.
async function sendCalendarInviteEmail({ apptId, lead, scheduled, title, duration, location, notes, type, userId, leadId }) {
  const end = new Date(scheduled.getTime() + (duration || 15) * 60000);
  const host = hostFor(userId);
  const icsContent = generateICS({
    id: apptId, scheduled, end, title, location, leadName: lead.name, leadEmail: lead.email, host,
  });

  const dateStr = scheduled.toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const timeStr = scheduled.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
  const withWhom = host.business && host.business !== host.name ? `${host.name} from ${host.business}` : host.name;
  const where = location
    ? `<p style="margin:12px 0 4px;font-size:14px"><strong>Join:</strong> <a href="${htmlText(location)}">${htmlText(location)}</a></p>`
    : `<p style="margin:12px 0 4px;font-size:14px">${htmlText(host.name)} will send the joining link before the meeting.</p>`;
  const details = `
    <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:16px 0">
      <p style="margin:4px 0;font-size:14px"><strong>Date:</strong> ${dateStr}</p>
      <p style="margin:4px 0;font-size:14px"><strong>Time:</strong> ${timeStr} (Malaysia time)</p>
      <p style="margin:4px 0;font-size:14px"><strong>Duration:</strong> ${Number(duration) || 15} minutes</p>
      ${where}
    </div>`;
  const ical = { filename: 'invite.ics', method: 'REQUEST', content: icsContent };

  await sendEmail({
    to: lead.email,
    subject: `Confirmed: ${title} — ${dateStr}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <p style="font-size:15px;line-height:1.6;color:#333">Hi ${htmlText(lead.name || 'there')},</p>
        <p style="font-size:15px;line-height:1.6;color:#333">Your ${type === 'demo' ? 'demo' : 'meeting'} with ${htmlText(withWhom)} is confirmed.</p>
        ${details}
        <p style="font-size:14px;color:#666">A calendar invite is attached. Reply to this email if you need to change the time.</p>
      </div>`,
    icalEvent: ical,
    ...senderFor(userId),
  });

  if (host.email && host.email !== lead.email) {
    await sendEmail({
      to: host.email,
      subject: `New meeting: ${lead.name || 'a prospect'}${lead.company ? ` (${lead.company})` : ''} — ${dateStr}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px">
          <p style="font-size:15px;color:#333">A meeting is booked with <strong>${htmlText(lead.name || '')}</strong>${lead.company ? ` from ${htmlText(lead.company)}` : ''} (${htmlText(lead.email)}).</p>
          ${details}
          ${notes ? `<p style="font-size:14px;color:#333"><strong>Notes from the call:</strong><br>${htmlText(notes).replace(/\n/g, '<br>')}</p>` : ''}
          <p style="font-size:13px;color:#888">The prospect has the invite. Add the attached event to your calendar.</p>
        </div>`,
      icalEvent: ical,
    }).catch(err => console.error('Host meeting copy failed:', err.message));
  }

  db.prepare('UPDATE appointments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('confirmed', apptId);
  if (leadId) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(userId, leadId, 'email', `Sent calendar invite for: ${title}`);
  }
}

// Export for use in voice.js
export { generateICS, sendCalendarInviteEmail, hostFor };

export default router;
