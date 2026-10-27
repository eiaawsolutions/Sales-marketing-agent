import cron from 'node-cron';
import db from '../db/index.js';
import { processOutreachQueue } from './outreach-dispatch.js';
import { refreshMetrics } from './metrics.js';
import { runRetention } from './retention.js';
import { processInboundReplies } from './inbound-replies.js';
import { runMondayBriefs } from './weekly-brief.js';
import { runMonthlyReports } from './monthly-report.js';

/**
 * Background scheduler — runs every 30 minutes.
 * 1. Process outreach_queue: send pending emails where scheduled_at has passed
 * 2. Process scheduled campaigns: launch pipeline at scheduled time
 */
export function startScheduler() {
  // Run every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[Scheduler] Running at', new Date().toISOString());
    await processOutreachQueue();
    await processScheduledCampaigns();
    await processInboundReplies().catch(e => console.error('[Scheduler] replies:', e.message));
  });

  // Daily midnight: refresh system metrics (code stats, AI costs, DB counts)
  cron.schedule('0 0 * * *', async () => {
    console.log('[Scheduler] Midnight metrics refresh');
    await refreshMetrics();
  }, { timezone: 'Asia/Kuala_Lumpur' });

  // Daily 03:15 MYT: retention deletes promised in the privacy notice §8,
  // Terms §9 and DPA §10 (enquiries 24 months after last contact; accounts 90
  // days after the subscription ends). Idempotent; logs counts only.
  // RETENTION_DRY_RUN=1 reports what it would delete without deleting.
  cron.schedule('15 3 * * *', () => {
    try {
      runRetention({ dryRun: process.env.RETENTION_DRY_RUN === '1' });
    } catch (err) {
      console.error('[Retention] failed:', err.message);
    }
  }, { timezone: 'Asia/Kuala_Lumpur' });

  // Monday 08:00 MYT: the Monday brief to every active account with leads.
  cron.schedule('0 8 * * 1', async () => {
    try { console.log(`[Brief] sent ${await runMondayBriefs()} Monday briefs`); } catch (err) { console.error('[Brief] failed:', err.message); }
  }, { timezone: 'Asia/Kuala_Lumpur' });

  // 1st of the month, 08:00 MYT: last month's report to every account that did anything.
  cron.schedule('0 8 1 * *', async () => {
    try { console.log(`[Report] sent ${await runMonthlyReports()} monthly reports`); } catch (err) { console.error('[Report] failed:', err.message); }
  }, { timezone: 'Asia/Kuala_Lumpur' });

  // Also run once on startup (after 15-second delay to let DB initialize)
  setTimeout(async () => {
    console.log('[Scheduler] Initial run');
    await processOutreachQueue();
    await processScheduledCampaigns();
    await refreshMetrics();
  }, 15000);

  console.log('[Scheduler] Started — outreach and replies every 30min, metrics daily at midnight MYT, retention daily at 03:15 MYT, Monday brief Mon 08:00 MYT, monthly report 1st 08:00 MYT');
}

// The dispatcher lives in outreach-dispatch.js so approvals can kick it too.
export { processOutreachQueue };

async function processScheduledCampaigns() {
  try {
    const scheduled = db.prepare(`
      SELECT * FROM campaigns
      WHERE status = 'scheduled'
        AND scheduled_at <= datetime('now')
    `).all();

    if (scheduled.length === 0) return;
    console.log(`[Scheduler] Launching ${scheduled.length} scheduled campaigns`);

    for (const campaign of scheduled) {
      try {
        const { launchCampaignPipeline } = await import('./pipeline-automation.js');
        await launchCampaignPipeline(campaign.user_id, campaign.id);
        console.log(`[Scheduler] Launched campaign: ${campaign.name}`);
      } catch (err) {
        console.error(`[Scheduler] Failed to launch campaign ${campaign.id}:`, err.message);
        db.prepare("UPDATE campaigns SET status = 'draft', pipeline_status = 'failed' WHERE id = ?").run(campaign.id);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Scheduled campaigns error:', err.message);
  }
}
