import db from './index.js';

console.log('Seeding database...');

// Clear existing data
db.exec('DELETE FROM activities');
db.exec('DELETE FROM campaign_leads');
db.exec('DELETE FROM generated_content');
db.exec('DELETE FROM agent_tasks');
db.exec('DELETE FROM pipeline');
db.exec('DELETE FROM campaigns');
db.exec('DELETE FROM leads');

// Seed leads
const insertLead = db.prepare(`
  INSERT INTO leads (name, email, company, title, phone, source, score, status, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const leads = [
  ['Sarah Chen', 'sarah@techflow.io', 'TechFlow', 'VP of Marketing', '555-0101', 'linkedin', 85, 'qualified', 'Expressed strong interest in AI automation. Budget approved for Q2.'],
  ['Marcus Johnson', 'marcus@growthco.com', 'GrowthCo', 'CEO', '555-0102', 'referral', 72, 'proposal', 'Referred by David. Scaling team from 20 to 50 this year.'],
  ['Emily Rodriguez', 'emily@scalehq.com', 'ScaleHQ', 'Head of Sales', '555-0103', 'website', 68, 'contacted', 'Downloaded whitepaper on sales automation.'],
  ['James Wilson', 'james@datadriven.co', 'DataDriven', 'CTO', '555-0104', 'event', 55, 'new', 'Met at SaaS Summit 2024. Technical buyer.'],
  ['Aisha Patel', 'aisha@cloudnine.io', 'CloudNine', 'Director of Growth', '555-0105', 'ad', 78, 'negotiation', 'Responded to LinkedIn ad. In final pricing discussions.'],
  ['Tom Baker', 'tom@startupx.com', 'StartupX', 'Founder', '555-0106', 'cold_outreach', 30, 'new', 'Early-stage startup. Might not have budget yet.'],
  ['Lisa Chang', 'lisa@enterprise.com', 'EnterpriseCo', 'VP Sales', '555-0107', 'referral', 90, 'qualified', 'Enterprise client. $500K+ potential deal.'],
  ['Ryan O\'Brien', 'ryan@mediamax.io', 'MediaMax', 'CMO', '555-0108', 'website', 62, 'contacted', 'Signed up for demo. Looking for content automation.'],
  ['Nina Kowalski', 'nina@fintechpro.com', 'FinTechPro', 'Head of Marketing', '555-0109', 'linkedin', 45, 'new', 'Connected on LinkedIn. Fintech compliance needs.'],
  ['David Kim', 'david@retailai.com', 'RetailAI', 'COO', '555-0110', 'event', 58, 'contacted', 'Interested in retail-specific marketing automation.'],
];

for (const lead of leads) {
  insertLead.run(...lead);
}

// Seed campaigns
const insertCampaign = db.prepare(`
  INSERT INTO campaigns (name, type, status, subject, body, target_audience, sent_count, open_count, click_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const campaigns = [
  ['Q2 Product Launch', 'email', 'active', 'Introducing AI-Powered Sales Automation', '<h1>Transform Your Sales Process</h1><p>Our new AI agent handles lead scoring, email campaigns, and pipeline analysis automatically.</p><p><a href="#">Learn More</a></p>', 'SaaS founders and VPs of Sales', 150, 68, 23],
  ['LinkedIn Thought Leadership', 'social', 'active', null, 'Weekly LinkedIn posts about AI in sales and marketing', 'B2B decision makers', 12, 0, 0],
  ['Google Ads - Lead Gen', 'ad', 'active', null, 'AI Sales Automation | Close More Deals Faster', 'SMB owners searching for CRM/sales tools', 5000, 0, 340],
  ['Nurture Sequence - New Leads', 'email', 'draft', 'Welcome to the future of sales', '<p>Thanks for your interest! Here\'s how AI can transform your sales pipeline...</p>', 'New signups and website leads', 0, 0, 0],
  ['Customer Success Stories', 'content', 'draft', null, 'Case studies highlighting ROI from AI automation', 'Qualified leads in consideration phase', 0, 0, 0],
];

for (const campaign of campaigns) {
  insertCampaign.run(...campaign);
}

// Seed pipeline deals
const insertDeal = db.prepare(`
  INSERT INTO pipeline (lead_id, stage, deal_value, probability, expected_close_date, notes)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const pipelineDeals = [
  [1, 'qualification', 25000, 60, '2026-05-15', 'Budget discussion scheduled for next week'],
  [2, 'proposal', 45000, 70, '2026-04-30', 'Proposal sent. Waiting for feedback.'],
  [5, 'negotiation', 35000, 85, '2026-04-20', 'Final pricing discussion. Expected to close this month.'],
  [7, 'qualification', 150000, 50, '2026-06-30', 'Enterprise deal. Long sales cycle.'],
  [3, 'prospecting', 15000, 20, '2026-07-01', 'Early stage. Need to schedule discovery call.'],
  [4, 'prospecting', 20000, 15, '2026-08-01', 'Technical evaluation in progress.'],
  [8, 'proposal', 30000, 55, '2026-05-30', 'Content automation proposal. Reviewing with team.'],
  [10, 'qualification', 40000, 40, '2026-06-15', 'Retail-specific requirements gathering.'],
];

for (const deal of pipelineDeals) {
  insertDeal.run(...deal);
}

// Seed activities
const insertActivity = db.prepare(`
  INSERT INTO activities (lead_id, campaign_id, type, description, outcome)
  VALUES (?, ?, ?, ?, ?)
`);

const activities = [
  [1, null, 'call', 'Discovery call with Sarah - discussed pain points in lead scoring', 'Interested in demo. Budget approved.'],
  [1, null, 'email', 'Sent product overview and pricing', null],
  [2, null, 'meeting', 'Demo meeting with Marcus and team', 'Very positive. Requested proposal.'],
  [2, null, 'email', 'Sent proposal document', null],
  [5, null, 'call', 'Pricing negotiation call with Aisha', 'Agreed on terms. Pending legal review.'],
  [7, null, 'meeting', 'Initial meeting with Lisa from EnterpriseCo', 'Large potential. Needs enterprise features.'],
  [3, 1, 'email', 'Sent Q2 launch campaign email', 'Opened'],
  [8, 1, 'email', 'Sent Q2 launch campaign email', 'Clicked CTA'],
  [1, null, 'ai_action', 'AI scored lead: 85/100 — Strong intent signals and budget confirmation', null],
  [7, null, 'ai_action', 'AI qualified lead: QUALIFIED (90/100) — Enterprise buyer with clear need', null],
];

for (const activity of activities) {
  insertActivity.run(...activity);
}

// Add campaign-lead associations
const insertCampaignLead = db.prepare(`
  INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, status, sent_at) VALUES (?, ?, ?, ?)
`);

insertCampaignLead.run(1, 3, 'opened', '2026-04-01 10:00:00');
insertCampaignLead.run(1, 8, 'clicked', '2026-04-01 10:30:00');
insertCampaignLead.run(1, 4, 'sent', '2026-04-01 09:00:00');
insertCampaignLead.run(1, 6, 'sent', '2026-04-01 09:00:00');
insertCampaignLead.run(1, 9, 'pending', null);

console.log('Database seeded successfully!');
console.log(`  - ${leads.length} leads`);
console.log(`  - ${campaigns.length} campaigns`);
console.log(`  - ${pipelineDeals.length} pipeline deals`);
console.log(`  - ${activities.length} activities`);
