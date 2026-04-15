import { Router } from 'express';
import crypto from 'crypto';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { sendEmail } from '../utils/email.js';

const router = Router();
router.use(requireAuth);

/**
 * Generate a unique Google Meet-style link for each appointment.
 * Format: https://meet.google.com/xxx-xxxx-xxx (3-4-3 lowercase letters)
 * This creates a "new meeting" link that works when the host opens it.
 */
function generateMeetLink() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const pick = (n) => Array.from(crypto.randomBytes(n), b => chars[b % 26]).join('');
  return `https://meet.google.com/${pick(3)}-${pick(4)}-${pick(3)}`;
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

  // Auto-generate Google Meet link if no location provided
  const meetLink = location || generateMeetLink();

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
      sendCalendarInviteEmail(apptId, lead, new Date(scheduled_at), title, duration_minutes || 15, meetLink, notes, type, req.user.id, lead_id)
        .catch(err => console.error('Auto calendar invite error:', err.message));
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
    leadName: appt.lead_name, leadEmail: appt.lead_email,
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
    // Generate Meet link if appointment doesn't have one
    const meetLink = appt.location || generateMeetLink();
    if (!appt.location) {
      db.prepare('UPDATE appointments SET location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(meetLink, appt.id);
    }

    await sendCalendarInviteEmail(
      appt.id,
      { name: appt.lead_name, email: appt.lead_email, company: appt.lead_company },
      new Date(appt.scheduled_at), appt.title, appt.duration_minutes,
      meetLink, appt.notes, appt.type, req.user.id, appt.lead_id
    );

    res.json({ success: true, message: 'Calendar invite sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Shared ICS Generator ---
function generateICS({ id, scheduled, end, title, notes, location, leadName, leadEmail }) {
  const now = new Date();
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  // Include Google Meet link in description if it's a meet.google.com link
  const isMeetLink = location?.includes('meet.google.com');
  const description = [
    isMeetLink ? `Join Google Meet: ${location}` : '',
    notes || '',
  ].filter(Boolean).join('\\n\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EIAAW Solutions//SalesAgent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:appt-${id}@eiaaw.com`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(scheduled)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    location ? `LOCATION:${location}` : '',
    leadEmail ? `ATTENDEE;CN=${leadName || ''}:mailto:${leadEmail}` : '',
    'ORGANIZER;CN=EIAAW Solutions:mailto:noreply@eiaaw.com',
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

// --- Shared calendar invite email sender (used by auto-send + manual send-invite) ---
async function sendCalendarInviteEmail(apptId, lead, scheduled, title, duration, meetLink, notes, type, userId, leadId) {
  const end = new Date(scheduled.getTime() + (duration || 15) * 60000);

  const icsContent = generateICS({
    id: apptId, scheduled, end, title, notes,
    location: meetLink, leadName: lead.name, leadEmail: lead.email,
  });

  const dateStr = scheduled.toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const timeStr = scheduled.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
  const isMeetLink = meetLink?.includes('meet.google.com');

  await sendEmail({
    to: lead.email,
    subject: `Meeting Confirmed: ${title} — ${dateStr}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#2ec4b6;margin-bottom:16px">You're Booked!</h2>
        <p style="font-size:15px;line-height:1.6;color:#333">Hi ${lead.name || 'there'},</p>
        <p style="font-size:15px;line-height:1.6;color:#333">Your ${type === 'demo' ? 'demo' : 'meeting'} with EIAAW Solutions is confirmed.</p>
        <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:4px 0;font-size:14px"><strong>Date:</strong> ${dateStr}</p>
          <p style="margin:4px 0;font-size:14px"><strong>Time:</strong> ${timeStr}</p>
          <p style="margin:4px 0;font-size:14px"><strong>Duration:</strong> ${duration} minutes</p>
          ${isMeetLink ? `
            <p style="margin:12px 0 4px;font-size:14px"><strong>Join via Google Meet:</strong></p>
            <a href="${meetLink}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:bold">Join Meeting</a>
            <p style="margin:6px 0 0;font-size:12px;color:#888">${meetLink}</p>
          ` : meetLink ? `<p style="margin:4px 0;font-size:14px"><strong>Where:</strong> ${meetLink}</p>` : ''}
        </div>
        <p style="font-size:14px;color:#666">A calendar invite is attached. Add it to your calendar so you don't miss it.</p>
        ${notes ? `<p style="font-size:14px;color:#666"><strong>Notes:</strong> ${notes}</p>` : ''}
        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="font-size:12px;color:#999;text-align:center">EIAAW Solutions — AI-Human Sales Partnerships</p>
      </div>
    `,
    icalEvent: {
      filename: 'invite.ics',
      method: 'REQUEST',
      content: icsContent,
    },
  });

  // Mark appointment as confirmed
  db.prepare('UPDATE appointments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('confirmed', apptId);

  // Log activity
  if (leadId) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(userId, leadId, 'email', `Sent calendar invite for: ${title}`);
  }
}

// Export for use in voice.js
export { generateMeetLink, generateICS, sendCalendarInviteEmail };

export default router;
