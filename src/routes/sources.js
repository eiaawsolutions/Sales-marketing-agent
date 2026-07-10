// Authenticated management of lead sources, the staging inbox, scoring rules,
// and lead settings. Mounted behind requireAuth in server.js.
//
// Tenant scoping follows the repo idiom: superadmin sees everything (userId
// scope = null), everyone else is pinned to their own id. The one deviation is
// WRITE operations, which are always pinned to req.user.id even for superadmin —
// a superadmin creating a source creates it for themselves, not for a tenant
// they happen to be looking at.

import { Router } from 'express';
import db from '../db/index.js';
import { leadSourcesService, SOURCE_TYPES, GATED_SOURCE_TYPES } from '../services/lead-sources.js';
import { promoteInboxRow, rejectInboxRow } from '../services/lead-ingest.js';
import { getRules, getLeadSettings, ensureDefaultRules, SCORE_FIELDS, SCORE_OPS, isValidRule } from '../services/lead-scoring.js';

const router = Router();

function baseUrl() {
  return db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value
    || 'https://sa.eiaawsolutions.com';
}

// The one place the ingest URL is constructed, so the UI and the docs cannot drift.
function withIngestUrl(source) {
  if (!source || source.auth_mode === 'internal') return source;
  return { ...source, ingest_url: `${baseUrl()}/api/ingest/${source.ingest_key}` };
}

// ---------------------------------------------------------------- catalog
router.get('/types', (req, res) => {
  res.json({
    available: Object.entries(SOURCE_TYPES)
      .filter(([, m]) => m.inbound)
      .map(([type, m]) => ({ type, ...m })),
    builtin: Object.entries(SOURCE_TYPES)
      .filter(([, m]) => !m.inbound)
      .map(([type, m]) => ({ type, ...m })),
    gated: GATED_SOURCE_TYPES,
  });
});

// ---------------------------------------------------------------- sources
router.get('/', (req, res) => {
  const sources = leadSourcesService.getAll(req.user.id);
  res.json(sources.map(withIngestUrl));
});

router.get('/funnel', (req, res) => {
  res.json(leadSourcesService.funnel(req.user.id));
});

router.get('/:id', (req, res) => {
  const source = leadSourcesService.getById(req.user.id, parseInt(req.params.id, 10));
  if (!source) return res.status(404).json({ error: 'Source not found' });
  res.json(withIngestUrl(source));
});

router.post('/', (req, res) => {
  try {
    const created = leadSourcesService.create(req.user.id, req.body || {});
    // `secret` is present exactly once, here. It is never returned again.
    res.status(201).json(withIngestUrl(created));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const updated = leadSourcesService.update(req.user.id, parseInt(req.params.id, 10), req.body || {});
    if (!updated) return res.status(404).json({ error: 'Source not found' });
    res.json(withIngestUrl(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/rotate-secret', (req, res) => {
  try {
    const rotated = leadSourcesService.rotateSecret(req.user.id, parseInt(req.params.id, 10));
    if (!rotated) return res.status(404).json({ error: 'Source not found' });
    res.json(withIngestUrl(rotated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/rotate-key', (req, res) => {
  const rotated = leadSourcesService.rotateIngestKey(req.user.id, parseInt(req.params.id, 10));
  if (!rotated) return res.status(404).json({ error: 'Source not found' });
  res.json(withIngestUrl(rotated));
});

router.delete('/:id', (req, res) => {
  try {
    const ok = leadSourcesService.delete(req.user.id, parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Source not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- inbox
router.get('/inbox/list', (req, res) => {
  const status = ['pending', 'accepted', 'rejected', 'duplicate', 'error'].includes(req.query.status)
    ? req.query.status : 'pending';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const rows = db.prepare(`
    SELECT i.*, s.name AS source_name, s.type AS source_type, s.auth_mode
      FROM lead_inbox i JOIN lead_sources s ON s.id = i.source_id
     WHERE i.user_id = ? AND i.status = ?
     ORDER BY i.score DESC, i.received_at DESC
     LIMIT ?
  `).all(req.user.id, status, limit);

  res.json(rows.map((r) => ({
    ...r,
    // raw_payload can contain anything a stranger posted. The UI escapes it, but
    // there is no reason to ship it to the browser on a list view.
    raw_payload: undefined,
    score_breakdown: safeParse(r.score_breakdown, []),
  })));
});

router.get('/inbox/counts', (req, res) => {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS c FROM lead_inbox WHERE user_id = ? GROUP BY status'
  ).all(req.user.id);
  const counts = { pending: 0, accepted: 0, rejected: 0, duplicate: 0, error: 0 };
  for (const r of rows) counts[r.status] = r.c;
  res.json(counts);
});

router.get('/inbox/:id', (req, res) => {
  const row = db.prepare(`
    SELECT i.*, s.name AS source_name, s.type AS source_type
      FROM lead_inbox i JOIN lead_sources s ON s.id = i.source_id
     WHERE i.id = ? AND i.user_id = ?
  `).get(parseInt(req.params.id, 10), req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({
    ...row,
    score_breakdown: safeParse(row.score_breakdown, []),
    raw_payload: safeParse(row.raw_payload, {}),
  });
});

router.post('/inbox/:id/accept', (req, res) => {
  try {
    const result = promoteInboxRow(req.user.id, parseInt(req.params.id, 10));
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/inbox/:id/reject', (req, res) => {
  const ok = rejectInboxRow(req.user.id, parseInt(req.params.id, 10), req.body?.reason || 'rejected by user');
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

router.post('/inbox/bulk', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 500).map(Number).filter(Number.isInteger) : [];
  const action = req.body?.action === 'reject' ? 'reject' : 'accept';
  if (!ids.length) return res.status(400).json({ error: 'No ids provided' });

  const results = { accepted: 0, rejected: 0, failed: [] };
  for (const id of ids) {
    try {
      if (action === 'accept') {
        const r = promoteInboxRow(req.user.id, id);
        if (r.ok) results.accepted++;
        else results.failed.push({ id, reason: r.reason });
      } else {
        if (rejectInboxRow(req.user.id, id, req.body?.reason || 'bulk reject')) results.rejected++;
        else results.failed.push({ id, reason: 'not found' });
      }
    } catch (e) {
      results.failed.push({ id, reason: e.message });
    }
  }
  res.json(results);
});

// ---------------------------------------------------------------- scoring
router.get('/scoring/rules', (req, res) => {
  res.json({
    rules: getRules(db, req.user.id),
    fields: Object.keys(SCORE_FIELDS),
    ops: Object.keys(SCORE_OPS),
  });
});

router.post('/scoring/rules', (req, res) => {
  ensureDefaultRules(db, req.user.id);
  const rule = {
    name: String(req.body?.name || '').trim().slice(0, 120),
    field: req.body?.field,
    op: req.body?.op,
    value: req.body?.value === null || req.body?.value === undefined ? null : String(req.body.value).slice(0, 500),
    points: Number.parseInt(req.body?.points, 10),
  };
  if (!rule.name) return res.status(400).json({ error: 'Rule name is required' });
  if (!isValidRule(rule)) return res.status(400).json({ error: 'Unknown field, operator, or non-integer points' });
  if (Math.abs(rule.points) > 100) return res.status(400).json({ error: 'Points must be between -100 and 100' });

  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM lead_scoring_rules WHERE user_id = ?').get(req.user.id).n;
  const created = db.prepare(`
    INSERT INTO lead_scoring_rules (user_id, name, field, op, value, points, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(req.user.id, rule.name, rule.field, rule.op, rule.value, rule.points, next);
  res.status(201).json(created);
});

router.put('/scoring/rules/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM lead_scoring_rules WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Rule not found' });

  const merged = {
    name: req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 120) : existing.name,
    field: req.body?.field !== undefined ? req.body.field : existing.field,
    op: req.body?.op !== undefined ? req.body.op : existing.op,
    value: req.body?.value !== undefined ? (req.body.value === null ? null : String(req.body.value).slice(0, 500)) : existing.value,
    points: req.body?.points !== undefined ? Number.parseInt(req.body.points, 10) : existing.points,
  };
  if (!merged.name) return res.status(400).json({ error: 'Rule name is required' });
  if (!isValidRule(merged)) return res.status(400).json({ error: 'Unknown field, operator, or non-integer points' });
  if (Math.abs(merged.points) > 100) return res.status(400).json({ error: 'Points must be between -100 and 100' });

  const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
  const updated = db.prepare(`
    UPDATE lead_scoring_rules SET name = ?, field = ?, op = ?, value = ?, points = ?, enabled = ?
     WHERE id = ? AND user_id = ? RETURNING *
  `).get(merged.name, merged.field, merged.op, merged.value, merged.points, enabled, id, req.user.id);
  res.json(updated);
});

router.delete('/scoring/rules/:id', (req, res) => {
  const changes = db.prepare('DELETE FROM lead_scoring_rules WHERE id = ? AND user_id = ?')
    .run(parseInt(req.params.id, 10), req.user.id).changes;
  if (!changes) return res.status(404).json({ error: 'Rule not found' });
  res.json({ success: true });
});

// ---------------------------------------------------------------- settings
router.get('/settings/lead', (req, res) => {
  res.json(getLeadSettings(db, req.user.id));
});

router.put('/settings/lead', (req, res) => {
  getLeadSettings(db, req.user.id); // ensure the row exists

  const clampPct = (v, fallback) => {
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : fallback;
  };
  const current = getLeadSettings(db, req.user.id);
  const next = {
    ai_qualify_threshold: clampPct(req.body?.ai_qualify_threshold, current.ai_qualify_threshold),
    auto_promote_threshold: clampPct(req.body?.auto_promote_threshold, current.auto_promote_threshold),
    auto_create_deal: req.body?.auto_create_deal !== undefined ? (req.body.auto_create_deal ? 1 : 0) : current.auto_create_deal,
    default_deal_value: Number.isFinite(Number(req.body?.default_deal_value)) && Number(req.body.default_deal_value) >= 0
      ? Number(req.body.default_deal_value) : current.default_deal_value,
  };

  db.prepare(`
    UPDATE lead_settings
       SET ai_qualify_threshold = ?, auto_promote_threshold = ?,
           auto_create_deal = ?, default_deal_value = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
  `).run(next.ai_qualify_threshold, next.auto_promote_threshold, next.auto_create_deal, next.default_deal_value, req.user.id);

  res.json(getLeadSettings(db, req.user.id));
});

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

export default router;
