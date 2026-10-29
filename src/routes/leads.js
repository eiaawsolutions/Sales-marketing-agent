import { Router } from 'express';
import { leadsService, maskLeads, maskLead, scoreView } from '../services/leads.js';
import { runAgent } from '../services/ai-agent.js';
import { checkPlanLimit } from '../middleware/auth.js';
import db from '../db/index.js';
import { handleReply, sendReply } from '../services/replies.js';
import { startBriefSearch } from '../services/lead-search.js';
import { getJob } from '../services/jobs.js';
import { recordLinkedinNoteSent } from '../services/outreach-queue.js';

const router = Router();

// POST /api/leads/find — "Find decision-makers": one search from the Brief.
// Starts it as a background job and answers at once (202); the page polls
// GET /find/:jobId, because a search can outlast Cloudflare's 100-second
// request limit (jobs.js). Must be before /:id routes.
router.post('/find', (req, res) => {
  try {
    const job = startBriefSearch(req.user, { count: req.body?.count });
    res.status(202).json({ job_id: job.id, status: job.status, already_running: job.alreadyRunning });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/find/:jobId', (req, res) => {
  const job = getJob(req.user.id, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'That search is no longer running (the server may have restarted). Run it again.' });
  res.json(job);
});

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

// The AI task handlers in ai-agent.js look leads up by id alone
// (`SELECT * FROM leads WHERE id = ?`) and then UPDATE status/score on them.
// Without an ownership check here, any authenticated user could score, qualify,
// or generate outreach against another tenant's lead — an IDOR that both leaks
// the lead's data in the response and mutates it. Mirror the check already used
// by POST /:id/activities. Superadmin (userId scope = null) still reaches all.
function requireOwnedLead(req, res) {
  const userIdScope = req.user.role === 'superadmin' ? null : req.user.id;
  const lead = leadsService.getById(userIdScope, req.params.id);
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return null;
  }
  return lead;
}

// GET /:id/score-detail — the BANT breakdown, reasoning, next step and the
// signals and sources the lead was verified with. No contact details.
router.get('/:id/score-detail', (req, res) => {
  const lead = requireOwnedLead(req, res);
  if (!lead) return;
  res.json(scoreView(lead));
});

router.post('/:id/score', async (req, res) => {
  try {
    if (!requireOwnedLead(req, res)) return;
    checkPlanLimit(req, 'ai_action');
    const result = await runAgent(req.user.id, 'score_lead', { leadId: parseInt(req.params.id), campaignId: null });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/qualify', async (req, res) => {
  try {
    if (!requireOwnedLead(req, res)) return;
    checkPlanLimit(req, 'ai_action');
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
    if (!requireOwnedLead(req, res)) return;
    checkPlanLimit(req, 'ai_action');
    const result = await runAgent(req.user.id, 'craft_outreach', {
      leadId: parseInt(req.params.id), context: req.body.context,
      valueProposition: req.body.valueProposition,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/linkedin-note-sent — the team sent the note from the
// outreach window from their own LinkedIn account: log it, mark the lead
// Contacted, close any note still waiting in a campaign.
router.post('/:id/linkedin-note-sent', (req, res) => {
  const lead = requireOwnedLead(req, res);
  if (!lead) return;
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'The note is empty.' });
  res.json(recordLinkedinNoteSent({ userId: lead.user_id, leadId: lead.id, message, by: req.user.memberId ?? req.user.id }));
});

// POST /api/leads/:id/reply — log a prospect's reply (pasted from the inbox):
// stops their sequences, labels the intent, drafts an answer.
router.post('/:id/reply', async (req, res) => {
  try {
    const lead = requireOwnedLead(req, res);
    if (!lead) return;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Paste the reply text.' });
    checkPlanLimit(req, 'ai_action');
    res.json(await handleReply({ userId: lead.user_id, lead, text: text.slice(0, 10000) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/send-reply — send the answer the user approved
router.post('/:id/send-reply', async (req, res) => {
  try {
    const lead = requireOwnedLead(req, res);
    if (!lead) return;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'The reply is empty.' });
    const r = await sendReply({ userId: lead.user_id, lead, subject: req.body?.subject, body });
    if (r.error) return res.status(r.status).json({ error: r.error });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/reveal — reveal masked contact (costs 1 credit)
router.post('/:id/reveal', (req, res) => {
  try {
    const userId = req.user.role === 'superadmin' ? null : req.user.id;
    const lead = leadsService.getById(userId, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    // A LinkedIn-only lead: a reveal would use a credit and show nothing.
    if (!lead.email && !lead.phone) return res.status(409).json({ error: 'This lead has no email or phone to reveal. Reach them on LinkedIn.' });
    checkPlanLimit(req, 'contact_reveal');

    db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
      .run(req.user.id, lead.id, 'ai_action', `Contact revealed: ${lead.name} (${lead.email}${lead.phone ? ', ' + lead.phone : ''})`);

    res.json({ email: lead.email, phone: lead.phone, name: lead.name, company: lead.company });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
