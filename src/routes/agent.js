import { Router } from 'express';
import { runAgent, freeformChat } from '../services/ai-agent.js';
import db from '../db/index.js';

const router = Router();

router.post('/chat', async (req, res) => {
  try {
    const userId = req.user.role === 'superadmin' ? null : req.user.id;
    const response = await freeformChat(userId, req.body.message);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate/email', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'generate_email', req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate/social', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'generate_social', req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate/ad', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'generate_ad', req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate/seo', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'generate_seo', req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/suggest-actions', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'suggest_actions', { leadId: req.body.leadId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tasks', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const uw = userId ? ' WHERE user_id = ?' : '';
  const p = userId ? [userId] : [];
  res.json(db.prepare(`SELECT * FROM agent_tasks${uw} ORDER BY created_at DESC LIMIT 50`).all(...p));
});

router.get('/content', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  let query = 'SELECT * FROM generated_content WHERE 1=1';
  const params = [];
  if (userId) { query += ' AND user_id = ?'; params.push(userId); }
  if (req.query.type) { query += ' AND type = ?'; params.push(req.query.type); }
  query += ' ORDER BY created_at DESC LIMIT 50';
  res.json(db.prepare(query).all(...params));
});

// PUT /api/agent/content/:id — edit content
router.put('/content/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const existing = userId
    ? db.prepare('SELECT * FROM generated_content WHERE id = ? AND user_id = ?').get(req.params.id, userId)
    : db.prepare('SELECT * FROM generated_content WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Content not found' });

  const newContent = req.body.content;
  if (newContent !== undefined) {
    db.prepare('UPDATE generated_content SET content = ? WHERE id = ?').run(
      typeof newContent === 'string' ? newContent : JSON.stringify(newContent),
      req.params.id
    );
  }
  res.json(db.prepare('SELECT * FROM generated_content WHERE id = ?').get(req.params.id));
});

// DELETE /api/agent/content/:id — delete content
router.delete('/content/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  if (userId) {
    db.prepare('DELETE FROM generated_content WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  } else {
    db.prepare('DELETE FROM generated_content WHERE id = ?').run(req.params.id);
  }
  res.json({ success: true });
});

export default router;
