import { Router } from 'express';
import { listReplies, openReplyCount, getReply, answerReply, dismissReply } from '../services/replies.js';
import { inboundDomain } from '../services/reply-routing.js';

// The Replies inbox: every prospect reply in the account, its label, what the
// agent did, and the drafted answer waiting for a person. Rows are always
// read through the account (req.user.id), so one account never sees
// another's replies.
const router = Router();

router.get('/', (req, res) => {
  res.json({
    replies: listReplies(req.user.id, { open: req.query.status === 'open' }),
    automatic: !!inboundDomain(),
  });
});

router.get('/count', (req, res) => {
  res.json({ open: openReplyCount(req.user.id) });
});

// POST /:id/send — send the answer a person approved (edited or as drafted).
router.post('/:id/send', async (req, res) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'The answer is empty.' });
    const r = await answerReply(req.user.id, parseInt(req.params.id, 10), { subject: req.body?.subject, body });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/dismiss', (req, res) => {
  if (!dismissReply(req.user.id, parseInt(req.params.id, 10))) return res.status(404).json({ error: 'Reply not found' });
  res.json({ ok: true });
});

router.get('/:id', (req, res) => {
  const r = getReply(req.user.id, parseInt(req.params.id, 10));
  if (!r) return res.status(404).json({ error: 'Reply not found' });
  const { message_id: _mid, ...view } = r;
  res.json(view);
});

export default router;
