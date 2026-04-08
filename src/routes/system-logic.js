import { Router } from 'express';
import db from '../db/index.js';
import { requireSuperadmin } from '../middleware/auth.js';

const router = Router();

// All system-logic routes require superadmin
router.use(requireSuperadmin);

// POST /api/system-logic/auth — kept for frontend compatibility
router.post('/auth', (req, res) => {
  res.json({ success: true });
});

router.get('/', (req, res) => {
  const entries = db.prepare('SELECT * FROM system_logic ORDER BY topic, sort_order, id').all();
  const grouped = {};
  for (const entry of entries) {
    if (!grouped[entry.topic]) grouped[entry.topic] = [];
    grouped[entry.topic].push(entry);
  }
  res.json({ entries, grouped });
});

router.get('/topics', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT topic, COUNT(*) as count FROM system_logic GROUP BY topic ORDER BY MIN(sort_order)').all());
});

router.get('/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM system_logic WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  res.json(entry);
});

router.post('/', (req, res) => {
  const { topic, title, description, code_ref, content, sort_order } = req.body;
  const result = db.prepare(
    'INSERT INTO system_logic (topic, title, description, code_ref, content, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(topic, title, description || '', code_ref || '', content, sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM system_logic WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (['topic', 'title', 'description', 'code_ref', 'content', 'sort_order'].includes(key)) {
      fields.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (fields.length === 0) return res.json(db.prepare('SELECT * FROM system_logic WHERE id = ?').get(req.params.id));
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE system_logic SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM system_logic WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM system_logic WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/refresh', (req, res) => {
  res.json({ success: true, message: 'System logic refreshes on server restart.' });
});

export default router;
