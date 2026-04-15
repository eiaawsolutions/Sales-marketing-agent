import { Router } from 'express';
import { campaignsService } from '../services/campaigns.js';
import { runAgent, getAICostStats, getAICostByCampaign, getAICostLog, getOutreachQueue } from '../services/ai-agent.js';
import { checkPlanLimit } from '../middleware/auth.js';
import { maskLeads, maskLead } from '../services/leads.js';

const router = Router();

router.get('/', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json(campaignsService.getAll(userId, req.query));
});

router.get('/stats', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  res.json(campaignsService.getStats(userId));
});

// AI costs overview (must be before /:id)
router.get('/ai-costs', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const overall = getAICostStats(null, userId);
  const byCampaign = getAICostByCampaign(userId);
  res.json({ overall, byCampaign });
});

router.get('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const campaign = campaignsService.getById(userId, req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (req.user.role !== 'superadmin' && campaign.leads) {
    campaign.leads = maskLeads(campaign.leads);
  }
  res.json(campaign);
});

router.post('/', (req, res) => {
  try {
    checkPlanLimit(req, 'campaigns');
    const campaign = campaignsService.create(req.user.id, req.body);
    res.status(201).json(campaign);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const campaign = campaignsService.update(userId, req.params.id, req.body);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

router.delete('/:id', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  campaignsService.delete(userId, req.params.id);
  res.json({ success: true });
});

router.post('/:id/leads', (req, res) => {
  try {
    const campaign = campaignsService.addLeads(req.params.id, req.body.leadIds);
    if (req.user.role !== 'superadmin' && campaign.leads) {
      campaign.leads = maskLeads(campaign.leads);
    }
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/generate-leads', async (req, res) => {
  try {
    checkPlanLimit(req, 'auto_leads');
    checkPlanLimit(req, 'ai_action');
    const userId = req.user.role === 'superadmin' ? null : req.user.id;
    const campaign = campaignsService.getById(userId, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const result = await runAgent(req.user.id, 'generate_leads', {
      campaignId: campaign.id, campaignName: campaign.name,
      targetAudience: campaign.target_audience, count: req.body.count || 5,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/auto-outreach', async (req, res) => {
  try {
    checkPlanLimit(req, 'auto_outreach');
    checkPlanLimit(req, 'ai_action');
    const result = await runAgent(req.user.id, 'auto_outreach', {
      campaignId: parseInt(req.params.id),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/launch — launch the full automated pipeline
router.post('/:id/launch', async (req, res) => {
  try {
    checkPlanLimit(req, 'ai_action');
    const campaignId = parseInt(req.params.id);

    // Mark as running immediately
    db.prepare("UPDATE campaigns SET pipeline_status = 'running' WHERE id = ?").run(campaignId);
    res.json({ status: 'launching', campaignId });

    // Run pipeline in background (don't await — already responded)
    import('../services/pipeline-automation.js').then(({ launchCampaignPipeline }) => {
      launchCampaignPipeline(req.user.id, campaignId).catch(err => {
        console.error('Pipeline failed:', err.message);
        db.prepare("UPDATE campaigns SET pipeline_status = 'failed' WHERE id = ?").run(campaignId);
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/pipeline-status — check pipeline progress
router.get('/:id/pipeline-status', (req, res) => {
  const campaign = db.prepare('SELECT pipeline_status, pipeline_log FROM campaigns WHERE id = ?').get(req.params.id);
  res.json({
    status: campaign?.pipeline_status || 'idle',
    log: campaign?.pipeline_log ? JSON.parse(campaign.pipeline_log) : [],
  });
});

router.get('/:id/outreach-queue', (req, res) => {
  let queue = getOutreachQueue(parseInt(req.params.id));
  if (req.user.role !== 'superadmin') {
    queue = queue.map(item => {
      const masked = maskLead({ name: item.lead_name, email: item.lead_email, phone: '', company: item.lead_company });
      return { ...item, lead_name: masked.name, lead_email: masked.email, lead_company: item.lead_company };
    });
  }
  res.json(queue);
});

router.post('/:id/send', async (req, res) => {
  try {
    const result = await campaignsService.sendCampaign(req.user.id, req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/ai-costs', (req, res) => {
  const stats = getAICostStats(parseInt(req.params.id));
  const log = getAICostLog(parseInt(req.params.id), 50);
  const campaign = campaignsService.getById(null, req.params.id);
  res.json({ ...stats, budget_limit: campaign?.budget_limit || 0, log });
});

router.put('/:id/budget', (req, res) => {
  const userId = req.user.role === 'superadmin' ? null : req.user.id;
  const campaign = campaignsService.update(userId, req.params.id, { budget_limit: parseFloat(req.body.budget_limit) || 0 });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

export default router;
