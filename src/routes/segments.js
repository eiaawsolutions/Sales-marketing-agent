// Authenticated segment management. Mounted behind requireAuth in server.js.
//
// Every route pins the tenant to req.user.id — including for superadmin. A
// segment is a saved query over one tenant's leads; there is no cross-tenant
// segment, so the usual `superadmin ? null : id` widening does not apply here.

import { Router } from 'express';
import db from '../db/index.js';
import { segmentsService, filterSchema, validateFilter } from '../services/segments.js';
import { maskLeads } from '../services/leads.js';

const router = Router();

// The field/operator catalogue the UI builds its filter picker from. Serving it
// from the same maps the compiler uses means the UI can never offer a field the
// compiler will reject.
router.get('/schema', (req, res) => {
  res.json(filterSchema());
});

router.get('/', (req, res) => {
  res.json(segmentsService.getAll(req.user.id));
});

router.post('/preview', (req, res) => {
  try {
    const check = validateFilter(req.body?.filter);
    if (!check.valid) return res.status(400).json({ error: check.error });
    const result = segmentsService.preview(req.user.id, req.body.filter, req.body?.limit);
    res.json({
      total: result.total,
      sample: req.user.role === 'superadmin' ? result.sample : maskLeads(result.sample),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const segment = segmentsService.getById(req.user.id, parseInt(req.params.id, 10));
  if (!segment) return res.status(404).json({ error: 'Segment not found' });
  res.json(segment);
});

router.get('/:id/members', (req, res) => {
  const members = segmentsService.members(req.user.id, parseInt(req.params.id, 10), {
    limit: parseInt(req.query.limit, 10) || 500,
  });
  if (members === null) return res.status(404).json({ error: 'Segment not found' });
  res.json(req.user.role === 'superadmin' ? members : maskLeads(members));
});

router.get('/:id/count', (req, res) => {
  const count = segmentsService.count(req.user.id, parseInt(req.params.id, 10));
  if (count === null) return res.status(404).json({ error: 'Segment not found' });
  res.json({ count });
});

router.post('/', (req, res) => {
  try {
    res.status(201).json(segmentsService.create(req.user.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const updated = segmentsService.update(req.user.id, parseInt(req.params.id, 10), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Segment not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const ok = segmentsService.delete(req.user.id, parseInt(req.params.id, 10));
  if (!ok) return res.status(404).json({ error: 'Segment not found' });
  res.json({ success: true });
});

router.post('/:id/members', (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.map(Number).filter(Number.isInteger) : [];
  const added = segmentsService.addMembers(req.user.id, parseInt(req.params.id, 10), ids);
  if (added === null) return res.status(400).json({ error: 'Segment not found, or it is dynamic (membership is computed)' });
  res.json({ added });
});

router.delete('/:id/members', (req, res) => {
  const ids = Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.map(Number).filter(Number.isInteger) : [];
  const removed = segmentsService.removeMembers(req.user.id, parseInt(req.params.id, 10), ids);
  if (removed === null) return res.status(400).json({ error: 'Segment not found, or it is dynamic (membership is computed)' });
  res.json({ removed });
});

// Push a segment's members into a campaign. This is the payoff for segmenting:
// "everyone who booked a meeting and scored 60+" becomes an audience.
router.post('/:id/to-campaign', (req, res) => {
  const campaignId = parseInt(req.body?.campaign_id, 10);
  if (!Number.isInteger(campaignId)) return res.status(400).json({ error: 'campaign_id is required' });

  const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, req.user.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const members = segmentsService.members(req.user.id, parseInt(req.params.id, 10), { limit: 2000 });
  if (members === null) return res.status(404).json({ error: 'Segment not found' });

  const insert = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)');
  let added = 0;
  const run = db.transaction(() => {
    for (const lead of members) added += insert.run(campaignId, lead.id).changes;
  });
  run();

  res.json({ added, total: members.length });
});

export default router;
