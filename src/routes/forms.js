import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import db from '../db/index.js';
import { formsService } from '../services/forms.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ---------- Public routes (NO auth) ----------
// These are reached at /api/forms/public/* — server.js exempts this prefix
// from auth and CSRF. Order matters: register BEFORE requireAuth below.

const publicSubmitLimiter = rateLimit({
  windowMs: 60_000, max: 10, validate: false,
  message: { error: 'Too many submissions. Please slow down.' },
});

// Public form definition (for embedding / rendering)
router.get('/public/:id', (req, res) => {
  const form = formsService.getPublic(parseInt(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });
  // Drop user_id from public payload
  const { user_id, ...publicForm } = form;
  res.json(publicForm);
});

// Public submission
router.post('/public/:id/submit', publicSubmitLimiter, (req, res) => {
  try {
    const formId = parseInt(req.params.id);
    const form = formsService.getPublic(formId);
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const payload = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {};

    // Validate required fields + strip unknown ones
    const cleaned = {};
    for (const f of form.fields || []) {
      const val = payload[f.name];
      if (f.required && (val == null || val === '')) {
        return res.status(400).json({ error: `Missing required field: ${f.label || f.name}` });
      }
      if (val != null) {
        if (Array.isArray(val)) {
          cleaned[f.name] = val.map(v => String(v).slice(0, 500)).slice(0, 20);
        } else if (typeof val === 'object') {
          cleaned[f.name] = JSON.stringify(val).slice(0, 2000);
        } else {
          cleaned[f.name] = String(val).slice(0, 2000);
        }
      }
    }

    // Attacker can pass any campaign_id / lead_id in the public submit body.
    // Only honour the value when it actually belongs to the SAME tenant as
    // the form (form.user_id). Otherwise drop the reference silently — the
    // submission is still recorded, just without the attacker-supplied join,
    // so analytics and automation can't be polluted across tenants.
    let campaignId = req.body?.campaign_id ? parseInt(req.body.campaign_id) : null;
    let leadId = req.body?.lead_id ? parseInt(req.body.lead_id) : null;
    if (Number.isFinite(campaignId)) {
      const c = db.prepare('SELECT user_id FROM campaigns WHERE id = ?').get(campaignId);
      if (!c || c.user_id !== form.user_id) campaignId = null;
    } else campaignId = null;
    if (Number.isFinite(leadId)) {
      const l = db.prepare('SELECT user_id FROM leads WHERE id = ?').get(leadId);
      if (!l || l.user_id !== form.user_id) leadId = null;
    } else leadId = null;

    formsService.recordSubmission({
      formId,
      campaignId,
      leadId,
      data: cleaned,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
    });

    res.json({ success: true, redirect: form.redirect_url || null });
  } catch (err) {
    console.error('Form submit error:', err.message);
    res.status(500).json({ error: 'Submission failed' });
  }
});

// ---------- Public chatbot lead intake ----------
// Every EIAAW site's chatbot gates the visitor (name + email + phone) BEFORE
// the AI answers, and posts the captured details here so they land as a lead
// in the sa CRM. This is an INBOUND, self-reported opt-in: the visitor
// volunteered their own contact details, so — per the global Lead Generation
// Contract — we store ONLY the real values they typed (never guess, autofill,
// or synthesise an email/phone), format-validate them server-side, and tag the
// lead as self-reported so a human qualifies before any outreach. We never
// fabricate a digital footprint here; the "verifiable footprint" rule governs
// OUTBOUND sourcing, not a person handing us their own details.
//
// Owner: all chatbot leads are assigned to the founder account (user_id = 1),
// the same default the voice public-session uses. Triage/reassign in the CRM.
//
// Tighter limiter than the form submitter — a chatbot gate should fire once
// per visitor, so 5/min/IP is generous and still throttles abuse. The route
// lives under /api/forms/public/ so it inherits server.js's CSRF exemption.
const intakeLimiter = rateLimit({
  windowMs: 60_000, max: 5, validate: false,
  message: { error: 'Too many submissions. Please slow down.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits, spaces, +, -, (), min 7 digits after stripping non-digits.
function validPhone(p) {
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 20;
}
// Sites we accept chatbot intake from. Anything else is tagged generically so a
// spoofed value can't masquerade as a first-party product source.
const KNOWN_SITES = new Set(['parent', 'sales_agent', 'workforce', 'social_media_team', 'ads_agency']);

router.post('/public/lead-intake', intakeLimiter, (req, res) => {
  try {
    const b = req.body || {};
    // Trim + bound every field. Real submitted values only — nothing derived.
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.email || '').trim().slice(0, 160).toLowerCase();
    const phoneRaw = String(b.phone || '').trim().slice(0, 40);
    const company = String(b.company || '').trim().slice(0, 160);
    const site = KNOWN_SITES.has(String(b.site || '').trim()) ? String(b.site).trim() : 'unknown';

    // Server-side gate. Required: name + email + phone (matches the SMT gate).
    if (!name || !email || !phoneRaw) {
      return res.status(400).json({ error: 'Name, email, and phone are required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!validPhone(phoneRaw)) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }

    const OWNER_ID = 1; // founder — see note above
    const source = `chatbot_${site}`;

    // Notes fold: self-reported provenance so the CRM shows exactly how this
    // lead arrived and that it is NOT an externally-verified prospect.
    const notesLines = [
      'Lead type: Inbound (self-reported via website chatbot)',
      'Confidence: Self-reported — verify before outreach',
      `Site: ${site} (${req.headers['origin'] || req.headers['referer'] || 'unknown origin'})`,
    ];
    if (b.message) notesLines.push(`Visitor note: ${String(b.message).slice(0, 500)}`);
    if (b.page) notesLines.push(`Page: ${String(b.page).slice(0, 300)}`);
    const notes = notesLines.join('\n');

    // Global UNIQUE(email): if this person already exists as a lead, DON'T
    // error and DON'T overwrite good CRM data — append a dated intake note and
    // return the existing lead. Mirrors the AI/Apollo re-ownership pattern.
    const existing = db.prepare('SELECT * FROM leads WHERE email = ?').get(email);
    if (existing) {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const appended = `${existing.notes ? existing.notes + '\n' : ''}[${stamp}] Returned via ${site} chatbot; phone: ${phoneRaw}${company ? `; company: ${company}` : ''}`;
      db.prepare('UPDATE leads SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(appended.slice(0, 4000), existing.id);
      try {
        db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
          .run(existing.user_id || OWNER_ID, existing.id, 'note', `Returned via ${site} chatbot gate`);
      } catch (e) { /* activities table shape tolerant */ }
      return res.json({ success: true, deduped: true });
    }

    const result = db.prepare(`
      INSERT INTO leads (user_id, name, email, company, phone, source, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'new', ?)
    `).run(OWNER_ID, name, email, company || null, phoneRaw, source, notes);

    try {
      db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
        .run(OWNER_ID, result.lastInsertRowid, 'note', `New inbound lead via ${site} chatbot gate`);
    } catch (e) { /* non-fatal */ }

    res.json({ success: true, deduped: false });
  } catch (err) {
    console.error('Lead intake error:', err.message);
    res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }
});

// ---------- Authenticated CRUD ----------
router.use(requireAuth);

router.get('/', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json(formsService.getAll(userId));
});

router.get('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const form = formsService.getById(userId, parseInt(req.params.id));
  if (!form) return res.status(404).json({ error: 'Form not found' });
  res.json(form);
});

router.get('/:id/submissions', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const rows = formsService.getSubmissions(userId, parseInt(req.params.id));
  if (rows == null) return res.status(404).json({ error: 'Form not found' });
  res.json(rows);
});

router.post('/', (req, res) => {
  try {
    const form = formsService.create(req.user.id, req.body || {});
    res.status(201).json(form);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const form = formsService.update(userId, parseInt(req.params.id), req.body || {});
  if (!form) return res.status(404).json({ error: 'Form not found' });
  res.json(form);
});

router.delete('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const result = formsService.delete(userId, parseInt(req.params.id));
  if (!result) return res.status(404).json({ error: 'Form not found' });
  res.json({ success: true });
});

export default router;
