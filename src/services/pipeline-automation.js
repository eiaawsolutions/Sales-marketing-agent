import db from '../db/index.js';
import { runAgent } from './ai-agent.js';
import { loadPlanUser, checkPlanLimitForUser, remainingMonthlyAiLeads } from '../middleware/auth.js';
import { getProfile, hasOffer, isHqAccount, TONES } from './account-profile.js';

const LEADS_PER_LAUNCH = 10;

/**
 * Fully automated campaign pipeline.
 * Called when user clicks "Launch Pipeline" on a campaign.
 *
 * Steps:
 * 1. Generate leads (if target_audience set and no leads assigned)
 * 2. Score all unscored leads
 * 3. Generate email content (if body is empty)
 * 4. Draft outreach sequences (or queue them, if the account turned approval off)
 * 5. Approved steps send via outreach-dispatch.js: Day 0 at once, days 3 and 7 by the scheduler
 */
export async function launchCampaignPipeline(userId, campaignId) {
  const log = [];
  const updateStatus = (status, msg) => {
    if (msg) log.push({ time: new Date().toISOString(), msg });
    db.prepare('UPDATE campaigns SET pipeline_status = ?, pipeline_log = ? WHERE id = ?')
      .run(status, JSON.stringify(log), campaignId);
  };

  try {
    updateStatus('running', 'Pipeline started');

    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    // Update campaign to active
    db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaignId);

    // Plan rules apply to Launch exactly as to the individual buttons. Launch
    // used to check only the AI-action allowance, so Starter accounts got lead
    // search and auto-outreach, and no run respected the monthly lead cap.
    const owner = loadPlanUser(campaign.user_id);
    const planBlock = (resource) => {
      try { checkPlanLimitForUser(owner, resource); return null; } catch (e) { return e.message; }
    };

    // Step 1: Generate leads if needed
    const existingLeadCount = db.prepare('SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ?').get(campaignId).c;
    const leadBlock = planBlock('auto_leads') || planBlock('ai_leads_per_month');

    if (campaign.target_audience && existingLeadCount === 0 && leadBlock) {
      updateStatus('running', `Step 1: Skipped — ${leadBlock}`);
    } else if (campaign.target_audience && existingLeadCount === 0) {
      updateStatus('running', 'Step 1: Generating leads...');
      try {
        const leadResult = await runAgent(campaign.user_id, 'generate_leads', {
          campaignId,
          campaignName: campaign.name,
          targetAudience: campaign.target_audience,
          count: Math.min(LEADS_PER_LAUNCH, remainingMonthlyAiLeads(owner)),
        });
        const newCount = db.prepare('SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ?').get(campaignId).c;
        const provider = leadResult?.sourceProvider === 'apollo' ? 'Apollo' : 'AI Web Search';
        const fallbackNote = leadResult?.fallbackFrom === 'apollo' ? ' (Apollo found 0 matches → fell back to AI Web Search)' : '';
        const rejectedNote = leadResult?.rejected ? ` (${leadResult.rejected} rejected by verification gate)` : '';
        updateStatus('running', `Step 1: Generated ${newCount} leads from ${provider}${fallbackNote}${rejectedNote}`);
      } catch (e) {
        updateStatus('running', `Step 1: Lead generation failed (${e.message}) — continuing with existing leads`);
      }
    } else {
      updateStatus('running', `Step 1: Skipped — ${existingLeadCount} leads already assigned`);
    }

    // Step 2: Score all unscored leads
    const unscoredLeads = db.prepare(`
      SELECT l.id, l.name FROM campaign_leads cl
      JOIN leads l ON cl.lead_id = l.id
      WHERE cl.campaign_id = ? AND (l.score = 0 OR l.score IS NULL)
    `).all(campaignId);

    if (unscoredLeads.length > 0) {
      updateStatus('running', `Step 2: Scoring ${unscoredLeads.length} leads...`);
      let scored = 0;
      for (const lead of unscoredLeads.slice(0, 15)) { // Cap at 15 to control costs
        try {
          await runAgent(campaign.user_id, 'score_lead', { leadId: lead.id });
          scored++;
        } catch (e) {
          // Continue scoring others if one fails
        }
      }
      updateStatus('running', `Step 2: Scored ${scored} leads`);
    } else {
      updateStatus('running', 'Step 2: All leads already scored');
    }

    // Step 3: Generate email content if empty — about the account's own offer
    // (Brief page). It used to describe EIAAW's product for every account.
    const profile = getProfile(campaign.user_id);
    const briefReady = hasOffer(profile);
    if (!campaign.body && campaign.type === 'email' && !briefReady && !isHqAccount(campaign.user_id)) {
      updateStatus('running', 'Step 3: Skipped — add your business name and offer on the Brief page so the agent can write about it');
    } else if (!campaign.body && campaign.type === 'email') {
      updateStatus('running', 'Step 3: Generating email content...');
      try {
        const content = await runAgent(campaign.user_id, 'generate_email', {
          audience: campaign.target_audience || 'general',
          subject: campaign.subject || campaign.name,
          purpose: 'promotional',
          tone: briefReady ? (TONES[profile.tone] || TONES.warm) : 'professional',
          productInfo: briefReady
            ? `${profile.business_name} — ${profile.offer}${profile.call_to_action ? `. Call to action: ${profile.call_to_action}` : ''}`
            : 'EIAAW AI Sales Agent — AI-powered sales and marketing automation platform',
          proofPoints: briefReady ? (profile.proof_points || '') : undefined,
          ctaUrl: briefReady ? (profile.meeting_link || profile.website || undefined) : undefined,
        });
        db.prepare('UPDATE campaigns SET subject = COALESCE(NULLIF(subject, ""), ?), body = ? WHERE id = ?')
          .run(content.subject || campaign.subject || campaign.name, content.body_html || content.body_text, campaignId);
        updateStatus('running', 'Step 3: Email content generated');
      } catch (e) {
        updateStatus('running', `Step 3: Content generation failed (${e.message})`);
      }
    } else {
      updateStatus('running', 'Step 3: Email content already provided');
    }

    // Step 4 + 5: Generate outreach sequences and send Step 1
    const leadsForOutreach = db.prepare('SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ?').get(campaignId).c;

    const outreachBlock = planBlock('auto_outreach');
    let awaitingApproval = false;

    if (leadsForOutreach > 0 && outreachBlock) {
      updateStatus('running', `Step 4: Skipped — ${outreachBlock}`);
    } else if (leadsForOutreach > 0) {
      updateStatus('running', `Step 4: Generating outreach sequences for ${leadsForOutreach} leads...`);
      try {
        const r = await runAgent(campaign.user_id, 'auto_outreach', { campaignId });
        awaitingApproval = !!r?.approvalRequired && r.drafted > 0;
        updateStatus('running', awaitingApproval
          ? `Step 4: ${r.drafted} messages drafted for ${r.leadsProcessed} leads — waiting for your approval`
          : `Step 4: ${r?.queued || 0} messages queued for ${r?.leadsProcessed || 0} leads — first emails are sending now`);
      } catch (e) {
        updateStatus('running', `Step 4: Outreach generation failed (${e.message})`);
      }
    } else {
      updateStatus('running', 'Step 4: No leads to send outreach to');
    }

    // Step 5: approved messages are sent by outreach-dispatch.js — Day 0 at
    // once, follow-ups on days 3 and 7 via the scheduler.
    updateStatus('completed', awaitingApproval
      ? 'Pipeline complete — review and approve the drafts to start sending'
      : 'Pipeline complete — follow-ups scheduled for days 3 and 7');

  } catch (err) {
    updateStatus('failed', `Pipeline error: ${err.message}`);
    throw err;
  }
}
