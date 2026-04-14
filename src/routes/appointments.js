import { Router } from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { decrypt } from '../utils/crypto.js';

const router = Router();
router.use(requireAuth);

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

// POST /api/appointments — create appointment
router.post('/', (req, res) => {
  const { lead_id, title, scheduled_at, duration_minutes, type, notes, location } = req.body;
  if (!title || !scheduled_at) return res.status(400).json({ error: 'Title and scheduled_at required' });

  const result = db.prepare(
    `INSERT INTO appointments (lead_id, user_id, title, scheduled_at, duration_minutes, type, notes, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(lead_id || null, req.user.id, title, scheduled_at, duration_minutes || 15, type || 'demo', notes || null, location || null);

  // Log activity if lead linked
  if (lead_id) {
    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(req.user.id, lead_id, 'meeting', `Appointment scheduled: ${title} on ${new Date(scheduled_at).toLocaleString()}`);
  }

  res.json({ id: result.lastInsertRowid, success: true });
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

  const ics = generateICS(appt);
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="appointment-${appt.id}.ics"`,
  });
  res.send(ics);
});

// POST /api/appointments/:id/send-invite — send .ics email to lead
router.post('/:id/send-invite', async (req, res) => {
  const appt = db.prepare(
    `SELECT a.*, l.name as lead_name, l.email as lead_email, l.company as lead_company
     FROM appointments a LEFT JOIN leads l ON a.lead_id = l.id
     WHERE a.id = ? AND a.user_id = ?`
  ).get(req.params.id, req.user.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  if (!appt.lead_email) return res.status(400).json({ error: 'Lead has no email address' });

  try {
    const smtpHost = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
    const smtpPort = db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value || '587';
    const smtpUser = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
    const smtpPass = decrypt(db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value) || '';
    const fromEmail = db.prepare("SELECT value FROM settings WHERE key = 'from_email'").get()?.value;

    if (!smtpUser || !smtpHost) return res.status(400).json({ error: 'SMTP not configured' });

    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      host: smtpHost, port: parseInt(smtpPort), secure: parseInt(smtpPort) === 465,
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });

    const icsContent = generateICS(appt);
    const dt = new Date(appt.scheduled_at);
    const dateStr = dt.toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' });

    await transporter.sendMail({
      from: fromEmail || smtpUser,
      to: appt.lead_email,
      subject: `Meeting Confirmed: ${appt.title} — ${dateStr}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <h2 style="color:#2ec4b6;margin-bottom:16px">You're Booked!</h2>
          <p style="font-size:15px;line-height:1.6;color:#333">Hi ${appt.lead_name || 'there'},</p>
          <p style="font-size:15px;line-height:1.6;color:#333">Your ${appt.type === 'demo' ? 'demo' : 'meeting'} with EIAAW Solutions is confirmed.</p>
          <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:4px 0;font-size:14px"><strong>Date:</strong> ${dateStr}</p>
            <p style="margin:4px 0;font-size:14px"><strong>Time:</strong> ${timeStr}</p>
            <p style="margin:4px 0;font-size:14px"><strong>Duration:</strong> ${appt.duration_minutes} minutes</p>
            ${appt.location ? `<p style="margin:4px 0;font-size:14px"><strong>Where:</strong> ${appt.location}</p>` : ''}
          </div>
          <p style="font-size:14px;color:#666">A calendar invite is attached. Add it to your calendar so you don't miss it.</p>
          ${appt.notes ? `<p style="font-size:14px;color:#666"><strong>Notes:</strong> ${appt.notes}</p>` : ''}
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

    db.prepare('UPDATE appointments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('confirmed', appt.id);

    if (appt.lead_id) {
      db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
        .run(req.user.id, appt.lead_id, 'email', `Sent calendar invite for: ${appt.title}`);
    }

    res.json({ success: true, message: 'Calendar invite sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ICS Generator ---
function generateICS(appt) {
  const start = new Date(appt.scheduled_at);
  const end = new Date(start.getTime() + (appt.duration_minutes || 15) * 60000);
  const now = new Date();
  const uid = `appt-${appt.id}@eiaaw.com`;

  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EIAAW Solutions//SalesAgent//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${appt.title}`,
    `DESCRIPTION:${(appt.notes || '').replace(/\n/g, '\\n')}`,
    appt.location ? `LOCATION:${appt.location}` : '',
    appt.lead_email ? `ATTENDEE;CN=${appt.lead_name || ''}:mailto:${appt.lead_email}` : '',
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

export default router;
