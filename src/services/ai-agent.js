import Anthropic from '@anthropic-ai/sdk';
import db from '../db/index.js';

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function getClient() {
  const settings = getSettings();
  const apiKey = settings.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('API key not configured. Go to Settings to add your Anthropic API key.');
  return new Anthropic({ apiKey });
}

function getModel() {
  const settings = getSettings();
  return settings.ai_model || 'claude-sonnet-4-20250514';
}

// Extract clean error message from Anthropic SDK errors
function cleanAIError(err) {
  const msg = err.message || String(err);
  // Anthropic SDK errors look like: "400 {"type":"error","error":{"type":"...","message":"..."}}"
  const jsonMatch = msg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  return msg;
}

// Cost per 1M tokens (USD) — Claude pricing as of 2025
const MODEL_PRICING = {
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
};

function calculateCost(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-20250514'];
  return (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000);
}

function logAICost(campaignId, taskType, model, inputTokens, outputTokens, userId) {
  const totalTokens = inputTokens + outputTokens;
  const cost = calculateCost(model, inputTokens, outputTokens);
  db.prepare(`
    INSERT INTO ai_cost_log (campaign_id, task_type, input_tokens, output_tokens, total_tokens, cost_usd, model, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(campaignId || null, taskType, inputTokens, outputTokens, totalTokens, cost, model, userId || 1);
  return { inputTokens, outputTokens, totalTokens, cost };
}

function getCampaignCost(campaignId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens, COUNT(*) as call_count FROM ai_cost_log WHERE campaign_id = ?'
  ).get(campaignId);
  return row;
}

function checkBudget(campaignId) {
  if (!campaignId) return true;
  const campaign = db.prepare('SELECT budget_limit FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign || !campaign.budget_limit || campaign.budget_limit <= 0) return true;
  const usage = getCampaignCost(campaignId);
  if (usage.total_cost >= campaign.budget_limit) {
    throw new Error(`Budget limit reached for this campaign ($${usage.total_cost.toFixed(4)} / $${campaign.budget_limit.toFixed(2)}). Increase the budget in campaign settings to continue.`);
  }
  return true;
}

// Track last API call usage for logging
let _lastUsage = null;

const SYSTEM_PROMPT = `You are an expert AI sales and marketing agent. You help businesses:
- Generate and qualify leads
- Score leads based on engagement and fit
- Write compelling marketing emails, social media posts, and ad copy
- Analyze sales pipeline and suggest next actions
- Create personalized outreach strategies
- Optimize campaign performance

Always respond with actionable, specific advice. When generating content, match the brand voice and target audience.
When analyzing data, provide concrete metrics and recommendations.
Format your responses as JSON when the user requests structured output.`;

export async function runAgent(userId, taskType, input) {
  const campaignId = input.campaignId || null;

  // Check account budget
  checkAccountBudget(userId);
  // Check campaign budget
  checkBudget(campaignId);

  // Store userId in input for task handlers
  input._userId = userId;

  const taskRow = db.prepare(
    'INSERT INTO agent_tasks (user_id, type, input, status) VALUES (?, ?, ?, ?)'
  ).run(userId || 1, taskType, JSON.stringify(input), 'running');

  const taskId = taskRow.lastInsertRowid;
  _lastUsage = null;

  try {
    const result = await executeTask(taskType, input);

    // Log AI cost
    let costInfo = null;
    if (_lastUsage) {
      costInfo = logAICost(campaignId, taskType, _lastUsage.model, _lastUsage.inputTokens, _lastUsage.outputTokens, userId);
    }

    db.prepare(
      'UPDATE agent_tasks SET output = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(JSON.stringify(result), 'completed', taskId);

    return { taskId, ...result, _cost: costInfo };
  } catch (error) {
    if (_lastUsage) {
      logAICost(campaignId, taskType, _lastUsage.model, _lastUsage.inputTokens, _lastUsage.outputTokens, userId);
    }

    const friendlyMessage = cleanAIError(error);
    db.prepare(
      'UPDATE agent_tasks SET error = ?, status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(friendlyMessage, 'failed', taskId);

    throw new Error(friendlyMessage);
  }
}

function checkAccountBudget(userId) {
  if (!userId) return true;
  const user = db.prepare('SELECT budget_limit FROM users WHERE id = ?').get(userId);
  if (!user || !user.budget_limit || user.budget_limit <= 0) return true;
  const usage = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total_cost FROM ai_cost_log WHERE user_id = ?').get(userId);
  if (usage.total_cost >= user.budget_limit) {
    throw new Error(`Account budget limit reached ($${usage.total_cost.toFixed(4)} / $${user.budget_limit.toFixed(2)}). Contact your administrator to increase your budget.`);
  }
  return true;
}

// Get cost stats (exported for routes)
export function getAICostStats(campaignId, userId) {
  if (campaignId) {
    return getCampaignCost(campaignId);
  }
  const uw = userId ? ' WHERE user_id = ?' : '';
  const p = userId ? [userId] : [];
  return db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COALESCE(SUM(total_tokens), 0) as total_tokens, COUNT(*) as call_count FROM ai_cost_log${uw}`).get(...p);
}

export function getAICostByCampaign(userId) {
  const uf = userId ? ' WHERE c.user_id = ?' : '';
  const p = userId ? [userId] : [];
  return db.prepare(`
    SELECT c.id, c.name, c.budget_limit,
      COALESCE(SUM(a.cost_usd), 0) as total_cost,
      COALESCE(SUM(a.total_tokens), 0) as total_tokens,
      COUNT(a.id) as call_count
    FROM campaigns c
    LEFT JOIN ai_cost_log a ON a.campaign_id = c.id
    ${uf}
    GROUP BY c.id
    ORDER BY total_cost DESC
  `).all(...p);
}

export function getAICostLog(campaignId, limit) {
  if (campaignId) {
    return db.prepare('SELECT * FROM ai_cost_log WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?').all(campaignId, limit || 50);
  }
  return db.prepare('SELECT * FROM ai_cost_log ORDER BY created_at DESC LIMIT ?').all(limit || 50);
}

async function executeTask(taskType, input) {
  const handlers = {
    score_lead: scoreLeadTask,
    generate_email: generateEmailTask,
    generate_social: generateSocialTask,
    generate_ad: generateAdTask,
    analyze_pipeline: analyzePipelineTask,
    suggest_actions: suggestActionsTask,
    qualify_lead: qualifyLeadTask,
    generate_seo: generateSeoTask,
    craft_outreach: craftOutreachTask,
    generate_leads: generateLeadsTask,
    auto_outreach: autoOutreachTask,
  };

  const handler = handlers[taskType];
  if (!handler) throw new Error(`Unknown task type: ${taskType}`);
  return handler(input);
}

async function chat(userMessage, extraContext = '') {
  const systemPrompt = extraContext
    ? `${SYSTEM_PROMPT}\n\nAdditional context:\n${extraContext}`
    : SYSTEM_PROMPT;

  const client = getClient();
  const model = getModel();

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Capture usage for cost tracking
  _lastUsage = {
    model: response.model || model,
    inputTokens: response.usage?.input_tokens || 0,
    outputTokens: response.usage?.output_tokens || 0,
  };

  if (!response.content || !response.content[0] || !response.content[0].text) {
    throw new Error('AI returned an empty response. Please try again.');
  }
  return response.content[0].text;
}

async function chatJSON(userMessage, extraContext = '') {
  const raw = await chat(
    userMessage + '\n\nRespond ONLY with valid JSON, no markdown fences.',
    extraContext
  );
  const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI returned invalid JSON. Raw response: ${cleaned.substring(0, 200)}`);
  }
}

// --- Task Handlers ---

async function scoreLeadTask(input) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(input.leadId);
  if (!lead) throw new Error('Lead not found');

  const activities = db.prepare(
    'SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(lead.id);

  const result = await chatJSON(
    `Score this lead from 0-100 based on their profile and engagement. Return JSON with "score", "reasoning", and "recommended_action" fields.

Lead profile:
- Name: ${lead.name}
- Company: ${lead.company || 'Unknown'}
- Title: ${lead.title || 'Unknown'}
- Source: ${lead.source}
- Current status: ${lead.status}

Recent activities (${activities.length} total):
${activities.map(a => `- [${a.type}] ${a.description} (${a.created_at})`).join('\n') || 'No activities yet'}`
  );

  db.prepare('UPDATE leads SET score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(result.score, lead.id);

  db.prepare(
    'INSERT INTO activities (lead_id, type, description) VALUES (?, ?, ?)'
  ).run(lead.id, 'ai_action', `AI scored lead: ${result.score}/100 — ${result.reasoning}`);

  return result;
}

async function generateEmailTask(input) {
  const { subject, audience, tone, purpose, productInfo } = input;

  const result = await chatJSON(
    `Generate a marketing email. Return JSON with "subject", "preview_text", "body_html", and "body_text" fields.

Requirements:
- Purpose: ${purpose || 'promotional'}
- Target audience: ${audience || 'general'}
- Tone: ${tone || 'professional'}
- Subject hint: ${subject || 'auto-generate'}
- Product/service info: ${productInfo || 'general business'}

The email should be compelling, have a clear CTA, and be optimized for open rates.`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content, campaign_id) VALUES (?, ?, ?, ?, ?)'
  ).run(input._userId || 1, 'email', JSON.stringify(input), JSON.stringify(result), input.campaignId || null);

  return { contentId: content.lastInsertRowid, ...result };
}

async function generateSocialTask(input) {
  const { platform, topic, tone, hashtags } = input;

  const result = await chatJSON(
    `Generate a social media post. Return JSON with "post_text", "hashtags" (array), "best_time_to_post", and "engagement_tips" fields.

Requirements:
- Platform: ${platform || 'linkedin'}
- Topic: ${topic}
- Tone: ${tone || 'professional'}
- Include hashtags: ${hashtags !== false}

Optimize for engagement on the specified platform.`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content) VALUES (?, ?, ?, ?)'
  ).run(input._userId || 1, 'social_post', JSON.stringify(input), JSON.stringify(result));

  return { contentId: content.lastInsertRowid, ...result };
}

async function generateAdTask(input) {
  const { platform, objective, audience, budget, productInfo } = input;

  const result = await chatJSON(
    `Generate ad copy variations. Return JSON with "headline_options" (array of 3), "description_options" (array of 3), "cta_options" (array), and "targeting_suggestions" fields.

Requirements:
- Platform: ${platform || 'google'}
- Objective: ${objective || 'conversions'}
- Target audience: ${audience || 'general'}
- Budget range: ${budget || 'not specified'}
- Product/service: ${productInfo || 'general business'}

Follow ${platform || 'google'} ads best practices and character limits.`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content) VALUES (?, ?, ?, ?)'
  ).run(input._userId || 1, 'ad_copy', JSON.stringify(input), JSON.stringify(result));

  return { contentId: content.lastInsertRowid, ...result };
}

async function analyzePipelineTask() {
  const deals = db.prepare(`
    SELECT p.*, l.name, l.company, l.email
    FROM pipeline p JOIN leads l ON p.lead_id = l.id
    ORDER BY p.stage, p.deal_value DESC
  `).all();

  const summary = {
    total_deals: deals.length,
    total_value: deals.reduce((s, d) => s + d.deal_value, 0),
    by_stage: {},
  };

  for (const deal of deals) {
    if (!summary.by_stage[deal.stage]) {
      summary.by_stage[deal.stage] = { count: 0, value: 0 };
    }
    summary.by_stage[deal.stage].count++;
    summary.by_stage[deal.stage].value += deal.deal_value;
  }

  const result = await chatJSON(
    `Analyze this sales pipeline and provide insights. Return JSON with "health_score" (0-100), "bottlenecks" (array), "recommendations" (array), "forecast" object with "optimistic", "realistic", "pessimistic" revenue numbers, and "priority_deals" (array of deal names to focus on).

Pipeline data:
${JSON.stringify(summary, null, 2)}

Individual deals:
${deals.map(d => `- ${d.name} (${d.company}): ${d.stage} | $${d.deal_value} | ${d.probability}% | Close: ${d.expected_close_date || 'TBD'}`).join('\n') || 'No deals in pipeline'}`
  );

  return { pipeline_summary: summary, analysis: result };
}

async function suggestActionsTask(input) {
  const lead = input.leadId
    ? db.prepare('SELECT * FROM leads WHERE id = ?').get(input.leadId)
    : null;

  const recentActivities = db.prepare(
    'SELECT * FROM activities ORDER BY created_at DESC LIMIT 30'
  ).all();

  const openDeals = db.prepare(
    `SELECT p.*, l.name, l.company FROM pipeline p
     JOIN leads l ON p.lead_id = l.id
     WHERE p.stage NOT IN ('closed_won','closed_lost')
     ORDER BY p.deal_value DESC LIMIT 10`
  ).all();

  const result = await chatJSON(
    `Suggest the top 5 most impactful sales/marketing actions to take right now. Return JSON with "actions" array, each having "priority" (1-5), "type", "description", "expected_impact", and "target" fields.

${lead ? `Focus lead: ${lead.name} (${lead.company}) — Status: ${lead.status}, Score: ${lead.score}` : 'General suggestions'}

Recent activities:
${recentActivities.map(a => `- [${a.type}] ${a.description} (${a.created_at})`).join('\n') || 'None'}

Open deals:
${openDeals.map(d => `- ${d.name} (${d.company}): ${d.stage} | $${d.deal_value}`).join('\n') || 'None'}`
  );

  return result;
}

async function qualifyLeadTask(input) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(input.leadId);
  if (!lead) throw new Error('Lead not found');

  const result = await chatJSON(
    `Qualify this lead using BANT framework. Return JSON with "qualified" (boolean), "bant_score" object with "budget", "authority", "need", "timeline" each 0-25, "total_score" (0-100), "qualification_notes", and "next_steps" (array).

Lead:
- Name: ${lead.name}
- Company: ${lead.company || 'Unknown'}
- Title: ${lead.title || 'Unknown'}
- Source: ${lead.source}
- Notes: ${lead.notes || 'None'}
${input.additionalInfo ? `- Additional info: ${input.additionalInfo}` : ''}`
  );

  const newStatus = result.qualified ? 'qualified' : 'contacted';
  db.prepare('UPDATE leads SET status = ?, score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, result.total_score, lead.id);

  db.prepare(
    'INSERT INTO activities (lead_id, type, description) VALUES (?, ?, ?)'
  ).run(lead.id, 'ai_action', `AI qualification: ${result.qualified ? 'QUALIFIED' : 'NOT QUALIFIED'} (${result.total_score}/100)`);

  return result;
}

async function generateSeoTask(input) {
  const { topic, industry, competitors } = input;

  const result = await chatJSON(
    `Generate SEO content strategy. Return JSON with "primary_keywords" (array), "long_tail_keywords" (array), "content_ideas" (array of objects with "title", "type", "target_keyword"), "meta_description", and "optimization_tips" (array).

Requirements:
- Topic/niche: ${topic}
- Industry: ${industry || 'general'}
- Competitors: ${competitors || 'not specified'}

Focus on high-intent, commercial keywords that drive sales.`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content) VALUES (?, ?, ?, ?)'
  ).run(input._userId || 1, 'seo_keywords', JSON.stringify(input), JSON.stringify(result));

  return { contentId: content.lastInsertRowid, ...result };
}

async function craftOutreachTask(input) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(input.leadId);
  if (!lead) throw new Error('Lead not found');

  const result = await chatJSON(
    `Craft a personalized outreach sequence for this lead. Return JSON with "sequence" array of objects, each having "step" (number), "channel" (email/linkedin/call), "delay_days", "subject" (if email), "message", and "goal".

Lead:
- Name: ${lead.name}
- Company: ${lead.company || 'Unknown'}
- Title: ${lead.title || 'Unknown'}
- Source: ${lead.source}
${input.context ? `- Context: ${input.context}` : ''}
${input.valueProposition ? `- Our value proposition: ${input.valueProposition}` : ''}

Create a 4-5 step sequence that feels personal, not automated.`
  );

  db.prepare(
    'INSERT INTO activities (lead_id, type, description) VALUES (?, ?, ?)'
  ).run(lead.id, 'ai_action', `AI generated ${result.sequence?.length || 0}-step outreach sequence`);

  return result;
}

async function generateLeadsTask(input) {
  const { campaignId, targetAudience, campaignName, count } = input;
  const numLeads = Math.min(count || 5, 15);

  // Get existing lead emails to avoid duplicates
  const existingEmails = db.prepare('SELECT email FROM leads').all().map(r => r.email.toLowerCase());

  const result = await chatJSON(
    `Generate ${numLeads} realistic potential leads for a marketing campaign.

Campaign: "${campaignName || 'Marketing Campaign'}"
Target audience: "${targetAudience || 'general business professionals'}"

Return JSON with a "leads" array. Each lead must have:
- "name": Full realistic name
- "email": Realistic business email (use real-looking domains, NOT @example.com)
- "company": Real-sounding company name relevant to the target audience
- "title": Job title appropriate for the target audience
- "phone": Phone number with area code
- "source": Always "ai_generated"
- "notes": One sentence about why this person matches the target audience

Make the leads diverse and realistic for the specified target audience. Vary company sizes and seniority levels.
Do NOT use these existing emails: ${existingEmails.slice(0, 30).join(', ')}`
  );

  const leads = result.leads || [];
  const created = [];

  const leadUserId = input._userId || 1;
  const insertLead = db.prepare(`
    INSERT INTO leads (user_id, name, email, company, title, phone, source, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCampaignLead = db.prepare(
    'INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id) VALUES (?, ?)'
  );

  const addLeads = db.transaction((leadsToAdd) => {
    for (const lead of leadsToAdd) {
      // Skip duplicates
      if (existingEmails.includes(lead.email?.toLowerCase())) continue;

      const res = insertLead.run(
        leadUserId, lead.name, lead.email, lead.company, lead.title,
        lead.phone, 'ai_generated', lead.notes
      );
      const leadId = res.lastInsertRowid;

      // Auto-assign to campaign
      if (campaignId) {
        insertCampaignLead.run(campaignId, leadId);
      }

      // Log activity
      db.prepare(
        'INSERT INTO activities (lead_id, type, description) VALUES (?, ?, ?)'
      ).run(leadId, 'ai_action', `AI generated lead for campaign: ${campaignName || 'Unknown'}`);

      created.push({ id: leadId, ...lead });
    }
  });

  addLeads(leads);

  return { generated: created.length, leads: created, campaignId };
}

async function autoOutreachTask(input) {
  const { campaignId } = input;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const leads = db.prepare(`
    SELECT l.*, cl.status as campaign_status
    FROM campaign_leads cl JOIN leads l ON cl.lead_id = l.id
    WHERE cl.campaign_id = ?
  `).all(campaignId);

  if (!leads.length) throw new Error('No leads assigned to this campaign. Add leads first.');

  const alreadyQueued = db.prepare(
    'SELECT DISTINCT lead_id FROM outreach_queue WHERE campaign_id = ?'
  ).all(campaignId).map(r => r.lead_id);

  const newLeads = leads.filter(l => !alreadyQueued.includes(l.id));
  if (!newLeads.length) throw new Error('All leads already have outreach sequences. Check the outreach queue.');

  const insertStep = db.prepare(`
    INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, subject, message, goal, delay_days, scheduled_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'), ?)
  `);

  let totalSteps = 0;
  let sentCount = 0;
  const summary = [];

  // Process in batches of 3 to avoid token limits
  const BATCH_SIZE = 3;
  for (let i = 0; i < newLeads.length; i += BATCH_SIZE) {
    const batch = newLeads.slice(i, i + BATCH_SIZE);
    const leadsInfo = batch.map(l =>
      `- ${l.name} | ${l.company || 'Unknown'} | ${l.title || 'Unknown'} | Source: ${l.source} | Score: ${l.score}`
    ).join('\n');

    const result = await chatJSON(
      `Generate personalized outreach sequences for ${batch.length} leads for campaign "${campaign.name}".
Campaign: ${campaign.type} | Target: ${campaign.target_audience || 'general'}
${campaign.subject ? `Subject: ${campaign.subject}` : ''}

Leads:
${leadsInfo}

Return JSON: { "sequences": [ { "lead_name": "exact name", "steps": [ { "step": 1, "channel": "email", "delay_days": 0, "subject": "...", "message": "short personalized msg", "goal": "..." } ] } ] }

Rules: Step 1 = email, delay_days=0. Then steps 2-3 on days 3, 7. Keep messages SHORT (2-3 sentences). 3 steps per lead.`
    );

    const sequences = result.sequences || [];

    const queueBatch = db.transaction(() => {
      for (const seq of sequences) {
        const lead = batch.find(l => l.name === seq.lead_name);
        if (!lead) continue;

        for (const step of (seq.steps || [])) {
          const isImmediate = step.delay_days === 0 && step.step === 1;
          insertStep.run(
            campaignId, lead.id, step.step, step.channel,
            step.subject || null, step.message, step.goal || '',
            step.delay_days, step.delay_days,
            isImmediate ? 'sent' : 'pending'
          );
          totalSteps++;

          if (isImmediate) {
            db.prepare(
              'INSERT INTO activities (lead_id, campaign_id, type, description) VALUES (?, ?, ?, ?)'
            ).run(lead.id, campaignId, 'email',
              `Auto-outreach Step 1: ${step.subject || step.channel} — ${(step.message || '').substring(0, 100)}`
            );
            db.prepare(
              "UPDATE campaign_leads SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND lead_id = ? AND status = 'pending'"
            ).run(campaignId, lead.id);
            sentCount++;
          }
        }

        summary.push({
          lead: lead.name,
          steps: (seq.steps || []).length,
          firstAction: seq.steps?.[0]?.channel || 'email',
        });
      }
    });

    queueBatch();
  }

  if (sentCount > 0) {
    db.prepare('UPDATE campaigns SET status = ?, sent_count = sent_count + ? WHERE id = ?')
      .run('active', sentCount, campaignId);
  }

  return { leadsProcessed: summary.length, totalSteps, immediatelySent: sentCount, summary };
}

// Get outreach queue for a campaign (exported for routes)
export function getOutreachQueue(campaignId) {
  return db.prepare(`
    SELECT oq.*, l.name as lead_name, l.email as lead_email, l.company as lead_company
    FROM outreach_queue oq
    JOIN leads l ON oq.lead_id = l.id
    WHERE oq.campaign_id = ?
    ORDER BY oq.lead_id, oq.step
  `).all(campaignId);
}

export async function freeformChat(userId, message) {
  try {
    _lastUsage = null;
    const uw = userId ? ' WHERE user_id = ?' : '';
    const uf = userId ? ' AND user_id = ?' : '';
    const p = userId ? [userId] : [];

    // Gather full CRM data for context
    const allLeads = db.prepare(`SELECT id, name, email, company, title, source, score, status, notes FROM leads${uw} ORDER BY score DESC`).all(...p);
    const allCampaigns = db.prepare(`SELECT * FROM campaigns${uw} ORDER BY created_at DESC`).all(...p);
    const allDeals = db.prepare(`
      SELECT p.*, l.name, l.company, l.email FROM pipeline p
      JOIN leads l ON p.lead_id = l.id WHERE 1=1${uf.replace('user_id', 'p.user_id')} ORDER BY p.deal_value DESC
    `).all(...p);
    const recentActivities = db.prepare(
      `SELECT a.*, l.name as lead_name FROM activities a LEFT JOIN leads l ON a.lead_id = l.id WHERE 1=1${uf.replace('user_id', 'a.user_id')} ORDER BY a.created_at DESC LIMIT 20`
    ).all(...p);

    // Get leads per campaign
    const campaignLeads = db.prepare(`
      SELECT cl.campaign_id, l.id, l.name, l.email, l.company, l.score, l.status, cl.status as delivery_status
      FROM campaign_leads cl JOIN leads l ON cl.lead_id = l.id
    `).all();

    const campaignLeadMap = {};
    for (const cl of campaignLeads) {
      if (!campaignLeadMap[cl.campaign_id]) campaignLeadMap[cl.campaign_id] = [];
      campaignLeadMap[cl.campaign_id].push(cl);
    }

    // AI cost per campaign
    const costData = db.prepare(`
      SELECT campaign_id, COALESCE(SUM(cost_usd), 0) as total_cost, COUNT(*) as call_count
      FROM ai_cost_log WHERE campaign_id IS NOT NULL GROUP BY campaign_id
    `).all();
    const costMap = {};
    for (const c of costData) costMap[c.campaign_id] = c;

    // Build context string
    let context = `You have FULL ACCESS to this CRM system. Here is the complete current data:\n\n`;

    // Campaigns with their leads
    context += `=== CAMPAIGNS (${allCampaigns.length}) ===\n`;
    for (const c of allCampaigns) {
      const leads = campaignLeadMap[c.id] || [];
      const cost = costMap[c.id] || { total_cost: 0, call_count: 0 };
      context += `\nCampaign: "${c.name}" (ID: ${c.id})
  Type: ${c.type} | Status: ${c.status} | Target: ${c.target_audience || 'Not set'}
  Subject: ${c.subject || 'N/A'} | Sent: ${c.sent_count} | Opens: ${c.open_count} | Clicks: ${c.click_count}
  AI Cost: $${cost.total_cost.toFixed(4)} (${cost.call_count} calls) | Budget: ${c.budget_limit > 0 ? '$' + c.budget_limit : 'Unlimited'}
  Leads (${leads.length}): ${leads.length > 0 ? leads.map(l => `${l.name} (${l.company || 'N/A'}, score:${l.score}, ${l.delivery_status})`).join('; ') : 'None assigned'}\n`;
    }

    // All leads
    context += `\n=== ALL LEADS (${allLeads.length}) ===\n`;
    for (const l of allLeads) {
      context += `- ${l.name} | ${l.email} | ${l.company || 'N/A'} | ${l.title || 'N/A'} | Source: ${l.source} | Score: ${l.score} | Status: ${l.status}${l.notes ? ' | Notes: ' + l.notes.substring(0, 80) : ''}\n`;
    }

    // Pipeline
    context += `\n=== PIPELINE DEALS (${allDeals.length}) ===\n`;
    for (const d of allDeals) {
      context += `- ${d.name} (${d.company}) | Stage: ${d.stage} | Value: $${d.deal_value} | Probability: ${d.probability}% | Close: ${d.expected_close_date || 'TBD'}\n`;
    }

    // Recent activities
    context += `\n=== RECENT ACTIVITIES (last 20) ===\n`;
    for (const a of recentActivities) {
      context += `- [${a.type}] ${a.lead_name || 'System'}: ${a.description.substring(0, 100)} (${a.created_at})\n`;
    }

    // Summary
    const totalCost = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM ai_cost_log${uw}`).get(...p);
    const openValue = allDeals.filter(d => !['closed_won','closed_lost'].includes(d.stage)).reduce((s,d) => s + d.deal_value, 0);
    context += `\n=== SUMMARY ===
Total leads: ${allLeads.length} | Total campaigns: ${allCampaigns.length} | Open deals: ${allDeals.length} worth $${openValue.toLocaleString()}
Total AI spend: $${totalCost.total.toFixed(4)}\n`;

    const result = await chat(message, context);
    if (_lastUsage) logAICost(null, 'chat', _lastUsage.model, _lastUsage.inputTokens, _lastUsage.outputTokens, userId);
    return result;
  } catch (error) {
    if (_lastUsage) logAICost(null, 'chat', _lastUsage.model, _lastUsage.inputTokens, _lastUsage.outputTokens, userId);
    throw new Error(cleanAIError(error));
  }
}
