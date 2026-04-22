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

    const campaignId = req.body?.campaign_id ? parseInt(req.body.campaign_id) : null;
    const leadId = req.body?.lead_id ? parseInt(req.body.lead_id) : null;

    formsService.recordSubmission({
      formId,
      campaignId: Number.isFinite(campaignId) ? campaignId : null,
      leadId: Number.isFinite(leadId) ? leadId : null,
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
