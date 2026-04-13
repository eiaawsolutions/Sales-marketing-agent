import { Router } from 'express';
import { pipelineService } from '../services/pipeline.js';
import { runAgent } from '../services/ai-agent.js';
import { maskLead } from '../services/leads.js';

const router = Router();

router.get('/', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  let deals = pipelineService.getAll(userId, req.query);
  if (req.user.role !== 'superadmin') {
    deals = deals.map(d => {
      const masked = maskLead({ name: d.name, email: d.email, phone: '', company: d.company });
      return { ...d, name: masked.name, email: masked.email, company: d.company };
    });
  }
  res.json(deals);
});

router.get('/stats', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json(pipelineService.getStats(userId));
});

router.get('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const deal = pipelineService.getById(userId, req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  if (req.user.role !== 'superadmin') {
    const masked = maskLead({ name: deal.name, email: deal.email, phone: '', company: deal.company });
    deal.name = masked.name;
    deal.email = masked.email;
  }
  res.json(deal);
});

router.post('/', (req, res) => {
  try {
    const deal = pipelineService.create(req.user.id, req.body);
    res.status(201).json(deal);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const deal = pipelineService.update(userId, req.params.id, req.body);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  res.json(deal);
});

router.delete('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  pipelineService.delete(userId, req.params.id);
  res.json({ success: true });
});

router.post('/analyze', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'analyze_pipeline', {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
