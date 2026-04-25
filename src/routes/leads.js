import { Router } from 'express';
import { leadsService, maskLeads, maskLead } from '../services/leads.js';
import { runAgent } from '../services/ai-agent.js';
import { checkPlanLimit } from '../middleware/auth.js';
import db from '../db/index.js';

const router = Router();

router.get('/', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const leads = leadsService.getAll(userId, req.query);
  res.json(req.user.role === 'superadmin' ? leads : maskLeads(leads));
});

router.get('/stats', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json(leadsService.getStats(userId));
});

router.get('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const lead = leadsService.getById(userId, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(req.user.role === 'superadmin' ? lead : maskLead(lead));
});

router.post('/', (req, res) => {
  try {
    checkPlanLimit(req, 'leads');
    const lead = leadsService.create(req.user.id, req.body);
    res.status(201).json(lead);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const lead = leadsService.update(userId, req.params.id, req.body);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

router.delete('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  leadsService.delete(userId, req.params.id);
  res.json({ success: true });
});

router.get('/:id/activities', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json(leadsService.getActivities(userId, req.params.id));
});

router.post('/:id/activities', (req, res) => {
  // Ownership check: a logged-in user cannot inject activities into another
  // tenant's lead. Superadmin can write to any.
  const userIdScope = req.user.role === 'superadmin' ? null : req.user.id;
  const lead = leadsService.getById(userIdScope, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const activity = leadsService.addActivity(req.user.id, req.params.id, req.body);
  res.status(201).json(activity);
});

router.post('/:id/score', async (req, res) => {
  try {
    checkPlanLimit(req, 'ai_action');
    const result = await runAgent(req.user.id, 'score_lead', { leadId: parseInt(req.params.id), campaignId: null });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/qualify', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'qualify_lead', {
      leadId: parseInt(req.params.id), additionalInfo: req.body.additionalInfo,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/outreach', async (req, res) => {
  try {
    const result = await runAgent(req.user.id, 'craft_outreach', {
      leadId: parseInt(req.params.id), context: req.body.context,
      valueProposition: req.body.valueProposition,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/reveal — reveal masked contact (costs 1 credit)
router.post('/:id/reveal', (req, res) => {
  try {
    checkPlanLimit(req, 'contact_reveal');
    const userId = req.user.role === 'superadmin' ? null : req.user.id;
    const lead = leadsService.getById(userId, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(req.user.id, lead.id, 'ai_action', `Contact revealed: ${lead.name} (${lead.email}${lead.phone ? ', ' + lead.phone : ''})`);

    res.json({ email: lead.email, phone: lead.phone, name: lead.name, company: lead.company });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
