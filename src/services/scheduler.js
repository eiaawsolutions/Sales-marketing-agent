import cron from 'node-cron';
import db from '../db/index.js';
import { sendEmail } from '../utils/email.js';
import { injectTracking, appendFormCta } from './campaigns.js';
import { isSuppressed, prepareOutreachEmail } from './unsubscribe.js';
import { refreshMetrics } from './metrics.js';
import { runRetention } from './retention.js';

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

  // Also run once on startup (after 15-second delay to let DB initialize)
  setTimeout(async () => {
    console.log('[Scheduler] Initial run');
    await processOutreachQueue();
    await processScheduledCampaigns();
    await refreshMetrics();
  }, 15000);

  console.log('[Scheduler] Started — outreach every 30min, metrics daily at midnight MYT, retention daily at 03:15 MYT');
}

// Exported for tests.
export async function processOutreachQueue() {
  try {
    const pendingItems = db.prepare(`
      SELECT oq.*, l.email as lead_email, l.name as lead_name, c.name as campaign_name, c.user_id, c.form_id
      FROM outreach_queue oq
      JOIN leads l ON oq.lead_id = l.id
      JOIN campaigns c ON oq.campaign_id = c.id
      WHERE oq.status = 'pending'
        AND oq.channel IN ('email', 'ai_action')
        AND oq.scheduled_at <= datetime('now')
        AND c.status = 'active'
      ORDER BY oq.scheduled_at ASC
      LIMIT 20
    `).all();

    if (pendingItems.length === 0) return;
    console.log(`[Scheduler] Processing ${pendingItems.length} pending outreach items`);

    const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value || 'https://sa.eiaawsolutions.com';

    for (const item of pendingItems) {
      try {
        if (!item.lead_email) {
          db.prepare("UPDATE outreach_queue SET status = 'failed' WHERE id = ?").run(item.id);
          continue;
        }

        // Opted out of this account's email: skip, never send.
        if (isSuppressed(item.user_id, item.lead_email)) {
          db.prepare("UPDATE outreach_queue SET status = 'skipped' WHERE id = ?").run(item.id);
          continue;
        }

        // Unsubscribe link + one-click headers, then tracking
        const emailBody = item.message || `<p>Hi ${item.lead_name},</p><p>${item.goal || 'Just following up on our previous conversation.'}</p>`;
        const withForm = appendFormCta(emailBody, item.form_id, item.campaign_id, item.lead_id, baseUrl);
        const { html: withUnsub, headers } = prepareOutreachEmail({ html: withForm, baseUrl, campaignId: item.campaign_id, leadId: item.lead_id });
        const trackedHtml = injectTracking(withUnsub, item.campaign_id, item.lead_id, baseUrl);

        await sendEmail({
          to: item.lead_email,
          subject: item.subject || `Following up: ${item.campaign_name}`,
          html: trackedHtml,
          headers,
        });

        db.prepare("UPDATE outreach_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(item.id);
        db.prepare("UPDATE campaign_leads SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'")
          .run(item.campaign_id, item.lead_id);
        db.prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?')
          .run(item.campaign_id);
        db.prepare('INSERT INTO activities (lead_id, campaign_id, type, description, user_id) VALUES (?, ?, ?, ?, ?)')
          .run(item.lead_id, item.campaign_id, 'email',
            `Auto-outreach Step ${item.step}: ${item.subject || 'Follow-up'}`,
            item.user_id || 1);

        console.log(`[Scheduler] Sent Step ${item.step} to ${item.lead_email}`);

        // Small delay between sends to respect rate limits
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        db.prepare("UPDATE outreach_queue SET status = 'failed' WHERE id = ?").run(item.id);
        console.error(`[Scheduler] Failed to send to ${item.lead_email}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Outreach queue error:', err.message);
  }
}

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
