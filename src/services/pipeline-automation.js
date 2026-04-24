import db from '../db/index.js';
import { runAgent } from './ai-agent.js';

/**
 * Fully automated campaign pipeline.
 * Called when user clicks "Launch Pipeline" on a campaign.
 *
 * Steps:
 * 1. Generate leads (if target_audience set and no leads assigned)
 * 2. Score all unscored leads
 * 3. Generate email content (if body is empty)
 * 4. Generate outreach sequences + send Step 1
 * 5. Follow-ups auto-queued for scheduler (days 3, 7)
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

    // Step 1: Generate leads if needed
    const existingLeadCount = db.prepare('SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ?').get(campaignId).c;

    if (campaign.target_audience && existingLeadCount === 0) {
      updateStatus('running', 'Step 1: Generating leads...');
      try {
        const leadResult = await runAgent(userId, 'generate_leads', {
          campaignId,
          campaignName: campaign.name,
          targetAudience: campaign.target_audience,
          count: 10,
        });
        const newCount = db.prepare('SELECT COUNT(*) as c FROM campaign_leads WHERE campaign_id = ?').get(campaignId).c;
        const provider = leadResult?.sourceProvider === 'apollo' ? 'Apollo' : 'AI Web Search';
        const rejectedNote = leadResult?.rejected ? ` (${leadResult.rejected} rejected by verification gate)` : '';
        updateStatus('running', `Step 1: Generated ${newCount} leads from ${provider}${rejectedNote}`);
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
          await runAgent(userId, 'score_lead', { leadId: lead.id });
          scored++;
        } catch (e) {
          // Continue scoring others if one fails
        }
      }
      updateStatus('running', `Step 2: Scored ${scored} leads`);
    } else {
      updateStatus('running', 'Step 2: All leads already scored');
    }

    // Step 3: Generate email content if empty
    if (!campaign.body && campaign.type === 'email') {
      updateStatus('running', 'Step 3: Generating email content...');
      try {
        const content = await runAgent(userId, 'generate_email', {
          audience: campaign.target_audience || 'general',
          subject: campaign.subject || campaign.name,
          purpose: 'promotional',
          tone: 'professional',
          productInfo: 'EIAAW AI Sales Agent — AI-powered sales and marketing automation platform',
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

    if (leadsForOutreach > 0) {
      updateStatus('running', `Step 4: Generating outreach sequences for ${leadsForOutreach} leads...`);
      try {
        const outreachResult = await runAgent(userId, 'auto_outreach', { campaignId });
        const sent = outreachResult?.immediatelySent || outreachResult?.leadsProcessed || 0;
        updateStatus('running', `Step 4: Outreach created — ${sent} first emails sent`);
      } catch (e) {
        updateStatus('running', `Step 4: Outreach generation failed (${e.message})`);
      }
    } else {
      updateStatus('running', 'Step 4: No leads to send outreach to');
    }

    // Step 5 + 6: Follow-ups are already queued in outreach_queue by autoOutreachTask
    // The scheduler (scheduler.js) will process them at the scheduled times
    updateStatus('completed', 'Pipeline complete — follow-ups scheduled for days 3 and 7');

  } catch (err) {
    updateStatus('failed', `Pipeline error: ${err.message}`);
    throw err;
  }
}
