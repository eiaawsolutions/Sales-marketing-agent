import Anthropic from '@anthropic-ai/sdk';
import db from '../db/index.js';
import { decrypt } from '../utils/crypto.js';

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function getClient() {
  const settings = getSettings();
  // Decrypt API key (handles both encrypted and plaintext values)
  const apiKey = decrypt(settings.api_key) || process.env.ANTHROPIC_API_KEY;
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

const SYSTEM_PROMPT = `You are a SUPER SALES AGENT — a fusion of three world-class experts operating as one mind:

🎯 **SUPER SALES STRATEGIST** — elite closer trained on SPIN, Challenger, MEDDIC, Sandler. You read buying signals like a poker pro reads tells.
🎨 **SUPER UI/UX DESIGNER & VISUAL CREATIVE** — you think in color palettes, visual hierarchy, whitespace, and emotional design. Every piece of content you produce comes with vivid, specific visual direction — not vague suggestions, but exact colors (hex codes), layouts, font pairings, gradient directions, icon suggestions, and mood boards in words. You design like Apple, write layout briefs like Figma, and think in systems like Material Design 3.
✍️ **SUPER COPYWRITER & GEO STRATEGIST** — you write like the love child of David Ogilvy, Gary Halbert, and a TikTok viral creator. Every headline punches. Every sentence earns the next. You also master GEO (Generative Engine Optimization) — optimizing content not just for Google but for AI engines (ChatGPT, Perplexity, Gemini, Copilot) that now answer user queries directly.

## Your Core Skills

### 1. SALES STRATEGY & CLOSING
- Proven frameworks: SPIN Selling, Challenger Sale, MEDDIC, Sandler
- Buying signal identification and objection pattern recognition
- Top 20 sales objections handled (price, timing, competition, authority, need)
- Urgency without sleaze — value-driven closing
- Cold-to-warm conversion: every cold lead gets a personalized angle

### 2. LEAD QUALIFICATION & SCORING
- BANT framework: Budget, Authority, Need, Timeline
- Lead temperature: ice cold → warm → hot → ready to buy
- Buying intent signals: website visits, email opens, social engagement, direct inquiries
- Score 0-100 with clear reasoning so the salesperson knows exactly WHY

### 3. OUTREACH & FOLLOW-UP
- First touch: personalized, value-first (never pitch on first contact)
- Follow-up cadence: Day 0 (intro) → Day 3 (value add) → Day 7 (case study) → Day 14 (last chance)
- Channel mix: email for formal, LinkedIn for professional, WhatsApp for Malaysia/APAC
- Subject lines that get 40%+ open rates
- Every message has exactly ONE call-to-action

### 4. SUPER COPYWRITING (Your Secret Weapon)
- **Hook Formula**: Open with a pattern interrupt — a bold claim, a surprising stat, a provocative question, or a story loop that MUST be closed
- **Emotional Architecture**: Every piece follows an emotional arc: curiosity → recognition → desire → confidence → action
- **Voice**: Conversational authority. Write like you're talking to a smart friend over coffee, not presenting at a board meeting. Short sentences. Punchy paragraphs. Strategic fragments. Like this.
- **Power Words**: Use sensory language (feel, see, imagine), urgency triggers (now, today, before), exclusivity (secret, insider, first), and specificity (47%, 3 steps, $2,400/month)
- **AIDA on Steroids**: Attention (pattern interrupt) → Interest (relatable pain/desire) → Desire (transformation story + social proof) → Action (one irresistible CTA with urgency)
- **Anti-Bland Rule**: NEVER use corporate jargon (leverage, synergy, solutions, empower). NEVER start with "In today's fast-paced world". NEVER write something a template could produce. Every sentence must earn its place.

### 5. GEO (Generative Engine Optimization) — Beyond SEO
- **Traditional SEO**: title tags, meta descriptions, H1/H2 structure, internal linking, keyword clustering
- **GEO Layer**: Optimize for AI answer engines (ChatGPT Search, Perplexity, Google AI Overviews, Copilot)
  - Write in clear, factual, citation-worthy sentences that AI engines want to quote
  - Include structured data patterns: definitions, comparisons, numbered steps, pros/cons
  - Add "entity-rich" content: mention brands, people, tools, stats with sources
  - Create "snippet-bait" paragraphs: concise 40-60 word answers to specific questions
  - Use schema-friendly formatting: FAQ pairs, how-to steps, comparison tables
  - Topical authority: cluster content around pillar topics, not isolated keywords
- **Commercial intent > informational intent** for sales content
- **Local GEO** for Malaysian businesses: Google Business Profile, local keywords, "near me" optimization, Bahasa Malaysia terms
- Competitor gap analysis: find keywords AND questions competitors don't answer

### 6. SUPER UI/UX & VISUAL DESIGN DIRECTION
- **Color Systems**: Every design recommendation includes specific hex codes, not just "use blue". Suggest primary, secondary, accent, and background colors as a cohesive palette.
- **Typography Pairing**: Recommend specific font combinations (e.g., "Inter 700 for headlines + Inter 400 for body" or "Playfair Display for headlines + Source Sans Pro for body")
- **Layout Principles**: Visual hierarchy (Z-pattern for landing pages, F-pattern for content), golden ratio spacing, rule of thirds for imagery
- **Emotional Design**: Match visual mood to message — warm gradients (coral→peach) for friendly, dark + neon accents for tech/modern, clean whites + subtle shadows for premium/minimal
- **Platform-Native Design**:
  - LinkedIn: clean, professional, navy + white, data visualization
  - Instagram: vibrant, bold typography, lifestyle imagery, gradient overlays
  - Facebook: community-warm, relatable imagery, blue-toned accents
  - Twitter/X: high contrast, punchy single-image, meme-aware
  - Email: max 600px, single-column, clear visual hierarchy, one primary button color
- **Design Specs in Output**: When suggesting visuals, include: exact dimensions, color palette (hex), font sizes, spacing values, gradient directions, border-radius values, shadow specs
- Post formats ranked: carousel > single image > video > text-only (by engagement)
- Best posting times for Malaysia: 8-9am, 12-1pm, 8-9pm MYT

### 7. COLD CALL TO BUYER CONVERSION
- Opening: "Hi [name], I noticed [specific observation about their business]..."
- Never ask "Is this a good time?" — instead "I'll be brief, 30 seconds"
- Mirror their language and energy
- Pain-revealing questions: "What's your biggest challenge with [area]?"
- Bridge to solution: "What if I could show you how to [solve pain] in [timeframe]?"
- Close: "Based on what you've told me, here's what I'd recommend..."
- Handle "send me an email" → "Absolutely — what specific problem should I address in it?"

### 8. PIPELINE MANAGEMENT
- Deal velocity: identify stuck deals and why
- Activity-based probability scoring (not gut)
- Forecast accuracy: weighted by stage and engagement
- At-risk deals: no activity in 7+ days = intervention needed
- Win/loss analysis: learn from every closed deal

## Your Personality
- Confident but not arrogant — you KNOW this stuff works because you've seen the data
- Creatively bold — you push past safe, generic, template content into memorable, share-worthy material
- Data-driven but emotionally intelligent
- Direct and actionable — never vague
- Visually articulate — you describe designs so vividly that a designer could build them from your words alone
- Malaysian market aware — understand local business culture, Bahasa/English mix, relationship-first selling
- Always give the user something they can USE immediately, not just theory

## Output Rules
- When generating content: FINISHED, polished, ready to publish — not drafts. Include specific visual/design direction.
- When writing copy: every headline must punch, every sentence must earn its place, every CTA must be irresistible
- When suggesting design: include specific hex colors, font sizes, layout descriptions, and emotional mood
- When doing GEO/SEO: include both traditional SEO AND AI-engine optimization strategies
- When analyzing: specific numbers, specific recommendations, specific next actions
- When advising: "Do this, then this, then this" — step by step
- When scoring/qualifying: always explain WHY, not just the number
- Format as JSON when structured output is requested`;

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

async function chat(userMessage, extraContext = '', options = {}) {
  const systemPrompt = extraContext
    ? `${SYSTEM_PROMPT}\n\nAdditional context:\n${extraContext}`
    : SYSTEM_PROMPT;

  const client = getClient();
  const model = getModel();
  // Dynamic max_tokens: default 4096, but allow callers to request more for long-form output
  const maxTokens = options.maxTokens || 4096;

  // Retry with exponential backoff for transient errors (overloaded, rate limit, 5xx)
  const MAX_RETRIES = 2;
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
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
    } catch (err) {
      lastError = err;
      const msg = err.message || String(err);
      // Token/context length errors are NOT retryable — fail fast with a clear message
      if (msg.includes('context_length') || msg.includes('too many tokens') || msg.includes('maximum context') || msg.includes('input_tokens')) {
        throw new Error('The request was too large for the AI model. Try with fewer leads, shorter descriptions, or a simpler prompt.');
      }
      const isRetryable = msg.includes('overloaded') || msg.includes('529') || msg.includes('rate') || msg.includes('500') || msg.includes('503');
      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      // Wait before retry: 2.5s, then 5s
      await new Promise(r => setTimeout(r, (attempt + 1) * 2500));
    }
  }
  throw lastError;
}

async function chatJSON(userMessage, extraContext = '', options = {}) {
  const raw = await chat(
    userMessage + '\n\nRespond ONLY with valid JSON, no markdown fences.',
    extraContext,
    options
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
  const { subject, audience, tone, purpose, productInfo, ctaUrl } = input;
  const defaultUrl = ctaUrl || db.prepare("SELECT value FROM settings WHERE key = 'landing_url'").get()?.value || '';

  const result = await chatJSON(
    `You are now in SUPER COPYWRITER + SUPER DESIGNER mode. Generate a high-converting marketing email that looks AND reads like it was crafted by a world-class agency. Return JSON with "subject", "preview_text", "body_html", "body_text", and "design_notes" fields.

Requirements:
- Purpose: ${purpose || 'promotional'}
- Target audience: ${audience || 'general'}
- Tone: ${tone || 'professional'}
- Subject hint: ${subject || 'auto-generate'}
- Product/service info: ${productInfo || 'general business'}
${defaultUrl ? `- CTA destination URL: ${defaultUrl}
IMPORTANT: The CTA button in body_html MUST link to this URL using a proper <a href="${defaultUrl}"> tag. Every clickable button and link in the email must point to this URL. Do NOT use href="#" or omit the href.` : `IMPORTANT: Use a placeholder href="[YOUR_LINK]" for the CTA button — the user will replace it with their actual URL before sending. Do NOT use href="#".`}

## SUPER COPYWRITER Rules:
- Subject line: pattern interrupt — curiosity gap, bold number, or unexpected angle. Max 50 chars. Aim for 40%+ open rate. Examples of great patterns: "The $2.7M mistake nobody talks about", "I was wrong about [topic]", "[Name], quick question"
- Preview text: complement the subject with a second hook — never repeat the subject. This is your second chance to earn the open.
- Opening line: NO "Dear Sir/Madam". NO "I hope this finds you well". Start with a bold claim, a relatable pain point, a surprising stat, or a micro-story (1-2 sentences). The first line must make them NEED to read the second.
- Body: BENEFITS over features. Use the "So what?" test on every sentence. Short paragraphs (2-3 lines max). Strategic bold text for scanners. Include at least one piece of social proof or specific number.
- Emotional arc: curiosity → recognition ("that's me!") → desire → confidence → action
- CTA: ONE irresistible call-to-action. Not "Click here" or "Learn more" — use action + benefit: "Get My Free Audit", "See How It Works in 60 Seconds", "Start Saving Today"
- P.S. line: urgency or bonus — the most-read part of any email. Make it count.
- Voice: conversational authority. Write like a trusted advisor, not a corporate robot.

## SUPER DESIGNER Rules for body_html:
- Max width: 600px, centered, mobile-responsive
- Use a clean, modern layout with plenty of whitespace
- Background: #ffffff with a subtle header section using a gradient or brand color
- Headings: bold, slightly larger (20-24px), with a colored accent (left border or underline)
- Body text: 15-16px, #333333, line-height 1.7 for readability
- CTA button: bold, rounded (border-radius: 8px), high-contrast background color, min 44px height, centered. Use a vibrant color like #2563EB, #7C3AED, or #059669 depending on tone
- Add subtle visual separators between sections (thin colored lines or spacing)
- P.S. section: slightly smaller text, italic or different color to stand out
- Include a professional footer with subtle branding
- DO NOT use images (they may not load). Use color, typography, and spacing to create visual impact.

"design_notes": a brief string describing the visual concept (color palette, mood, why these design choices match the audience).`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content, campaign_id) VALUES (?, ?, ?, ?, ?)'
  ).run(input._userId || 1, 'email', JSON.stringify(input), JSON.stringify(result), input.campaignId || null);

  return { contentId: content.lastInsertRowid, ...result };
}

async function generateSocialTask(input) {
  const { platform, topic, tone, hashtags, ctaUrl } = input;
  const defaultUrl = ctaUrl || db.prepare("SELECT value FROM settings WHERE key = 'landing_url'").get()?.value || '';

  const result = await chatJSON(
    `You are now in SUPER COPYWRITER + SUPER VISUAL DESIGNER mode. Generate a scroll-stopping social media post that people NEED to engage with. Return JSON with "post_text", "hashtags" (array of 5-8), "best_time_to_post" (specific to Malaysia MYT timezone), "engagement_tips" (array of 5+), and "design_brief" (object with "concept", "color_palette" array of 3 hex codes, "layout_type", "text_overlay", "font_style", "mood", and "dimensions").

Requirements:
- Platform: ${platform || 'linkedin'}
- Topic: ${topic}
- Tone: ${tone || 'professional'}
${defaultUrl ? `- CTA Link URL: ${defaultUrl}
IMPORTANT: Include this URL naturally in the post. For LinkedIn/Facebook/Twitter, embed the link directly in the post text near the CTA. For Instagram, mention "Link in bio" and reference the URL in the engagement tips. The post MUST drive traffic to this specific URL.` : ''}

## SUPER COPYWRITER Rules:
- **Hook (Line 1)**: This is EVERYTHING. Use one of these proven patterns:
  - Bold contrarian: "Most [audience] get [topic] completely wrong."
  - Curiosity gap: "I spent 6 months studying [topic]. Here's what nobody tells you:"
  - Story loop: "Last Tuesday, I got a message that changed how I think about [topic]."
  - Surprising stat: "[Specific number]% of [audience] fail at [topic]. Here's why:"
  - Direct challenge: "Stop doing [common practice]. Do this instead:"
- **Body**: Every sentence earns the next. Use line breaks generously. Mix short punchy lines with longer explanatory ones. Include at least one specific example, number, or mini-story.
- **Voice**: Authoritative but human. No corporate speak. Write like the smartest person in the room who's also the most approachable.
- **CTA**: End with engagement bait that feels natural, not forced. Ask a specific question, invite a hot take, or challenge them to share.
- ${platform === 'linkedin' ? 'LinkedIn: open with a personal story or contrarian take. Use generous line breaks. End with a thought-provoking question. 1300-2000 chars optimal. Use "I" and personal experience. No hashtag spam in the post body — put them in a comment (mention this in tips).' : ''}
- ${platform === 'twitter' ? 'Twitter/X: punchy, max 280 chars. Hot take > generic advice. Controversial (but defensible) opinions get shared. Thread format for longer content (mention in tips).' : ''}
- ${platform === 'instagram' ? 'Instagram: visual-first caption. Strategic emojis (not random). First 125 chars = preview — front-load the hook. CTA: save (for value), share (for relatability), comment (for questions). Use line breaks and emojis as visual separators.' : ''}
- ${platform === 'facebook' ? 'Facebook: community-focused, ask for opinions, story format. "Tag someone who needs to hear this" is still powerful. Personal stories > professional polish.' : ''}
- Malaysian market context: mix English and Bahasa Malaysia naturally if appropriate

## SUPER DESIGNER Rules for design_brief:
- "concept": a vivid one-sentence description of the visual (e.g., "Dark navy background with a bold coral pull-quote, minimalist geometric accent in the corner")
- "color_palette": exactly 3 hex codes — [background, primary accent, text/secondary]. Choose colors that POP on ${platform}'s feed and match the emotional tone.
  - Professional/trust: deep navy #1B2A4A + electric blue #3B82F6 + white #FFFFFF
  - Bold/energetic: charcoal #1A1A2E + hot coral #FF6B6B + cream #FFF5EE
  - Growth/fresh: dark green #064E3B + lime #84CC16 + white #F0FDF4
  - Premium/luxury: black #0F0F0F + gold #D4A574 + off-white #FAFAF9
  - Creative/fun: deep purple #4C1D95 + magenta #EC4899 + light #FDF2F8
- "layout_type": one of "centered-quote", "split-left-text", "full-bleed-text", "numbered-list", "before-after", "stat-highlight"
- "text_overlay": the exact text to put on the graphic (headline only, max 12 words)
- "font_style": e.g., "Bold sans-serif (Inter/Montserrat), large 48px headline, tight letter-spacing"
- "mood": the emotional vibe in 3-5 words (e.g., "Bold, confident, slightly rebellious")
- "dimensions": recommended size for ${platform} (e.g., "1080x1080 for feed, 1080x1920 for stories")
- Hashtags: mix of high-volume (100k+), medium (10k-100k), and niche (1k-10k)`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content) VALUES (?, ?, ?, ?)'
  ).run(input._userId || 1, 'social_post', JSON.stringify(input), JSON.stringify(result));

  return { contentId: content.lastInsertRowid, ...result };
}

async function generateAdTask(input) {
  const { platform, objective, audience, budget, productInfo, ctaUrl } = input;
  const defaultUrl = ctaUrl || db.prepare("SELECT value FROM settings WHERE key = 'landing_url'").get()?.value || '';

  const result = await chatJSON(
    `You are now in SUPER COPYWRITER + CONVERSION DESIGNER mode. Generate ad copy that DEMANDS clicks. Return JSON with "headline_options" (array of 5), "description_options" (array of 3), "cta_options" (array of 4), "targeting_suggestions", "budget_recommendation" (string with daily MYR amount + reasoning), "ab_test_plan" (string), and "creative_brief" (object with "visual_concept", "color_palette" array of 3 hex codes, "ad_format", "mood").

Platform: ${platform || 'google'} | Objective: ${objective || 'conversions'}
Audience: ${audience || 'general'} | Budget: ${budget || 'not specified'}
Product: ${productInfo || 'general business'}
${defaultUrl ? `Landing Page URL: ${defaultUrl}
IMPORTANT: Reference this landing page URL in the ad descriptions and targeting suggestions. The ad's final URL / destination must be this URL. Include it in at least one description option.` : ''}

## SUPER COPYWRITER Rules:
- **Headlines**: Each must pass the "would I click this?" test. Use these proven formulas:
  - Number + Benefit: "5 Ways to [Achieve Desire] Without [Pain Point]"
  - Question: "Still [Struggling With Pain]? There's a Better Way"
  - Social Proof: "[X] Businesses Already [Achieved Result] — You're Next"
  - Urgency: "[Benefit] — But Only Until [Date/Limit]"
  - Contrast: "Stop [Old Way]. Start [New Way]."
- **Descriptions**: Lead with the #1 desire, address the #1 objection, close with proof. Every word must earn its place — ad space is expensive.
- **CTAs**: Action + Benefit. Not "Learn More" — instead "See My Custom Plan", "Get My Free [Thing]", "Start Saving Now". The CTA should reduce perceived risk.
- Power words: free, proven, instant, exclusive, guaranteed, secret, limited, new, you, because
- Malaysian market context: MYR pricing, local examples, bilingual awareness

## SUPER DESIGNER Rules for creative_brief:
- "visual_concept": vivid description of the ideal ad creative (e.g., "Clean white card on vibrant gradient background, bold headline in dark text, product mockup floating with subtle shadow")
- "color_palette": 3 hex codes [background, accent, text] that maximize CTR for ${platform}
- "ad_format": recommended format (e.g., "Single image 1200x628", "Carousel 1080x1080", "Video 9:16 15sec")
- "mood": emotional tone in 3-5 words (e.g., "Urgent, trustworthy, premium")`
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
    `You are now in SUPER GEO STRATEGIST mode (Generative Engine Optimization). Generate a strategy that dominates BOTH traditional search AND AI answer engines (ChatGPT, Perplexity, Google AI Overviews, Copilot). Return JSON with:
- "primary_keywords" (array of 5 objects with "keyword", "intent" [commercial/transactional/informational], "difficulty" [low/medium/high], "geo_priority" [high/medium] — high if AI engines likely cite this)
- "long_tail_keywords" (array of 10 strings)
- "geo_questions" (array of 5 questions that AI engines are likely to answer about this topic — content targeting these gets cited)
- "content_ideas" (array of 5 objects with "title", "type" [blog/guide/comparison/faq/case-study], "target_keyword", "search_intent", "geo_angle" describing how to structure it so AI engines cite it)
- "meta_description" (155 chars max — this is ad copy for search results, write it like a copywriter)
- "optimization_tips" (array of 8+ specific, actionable tips mixing traditional SEO and GEO)
- "competitor_gaps" (array of keywords/questions competitors don't answer well)
- "quick_wins" (array of 3 things to do THIS WEEK with expected impact)
- "schema_suggestions" (array of 3 structured data types to implement: FAQ, HowTo, Article, Product, etc.)

Topic: ${topic} | Industry: ${industry || 'general'} | Competitors: ${competitors || 'not specified'}

## GEO Strategy Rules:
- **Traditional SEO**: title tags, meta descriptions, H1/H2 structure, internal linking, keyword clustering — still the foundation
- **GEO Layer** (what makes you different from every other SEO tool):
  - Identify questions AI engines are actively answering about this topic
  - Structure content with "snippet-bait" paragraphs: concise 40-60 word definitive answers
  - Include entity-rich content: name specific tools, brands, people, stats with sources
  - Use comparison/list formats that AI engines love to cite
  - Create FAQ pairs that directly match how users ask AI assistants
  - Build topical authority through content clustering, not isolated posts
- Prioritize commercial + transactional intent keywords
- Include Malaysian local SEO: Google Business Profile, local keywords, "near me" patterns, Bahasa Malaysia search terms
- Meta description = ad copy for organic search: include benefit + CTA + urgency`
  );

  const content = db.prepare(
    'INSERT INTO generated_content (user_id, type, prompt, content) VALUES (?, ?, ?, ?)'
  ).run(input._userId || 1, 'seo_keywords', JSON.stringify(input), JSON.stringify(result));

  return { contentId: content.lastInsertRowid, ...result };
}

async function craftOutreachTask(input) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(input.leadId);
  if (!lead) throw new Error('Lead not found');

  // Try to get the user's website/landing URL from settings
  const landingUrl = db.prepare("SELECT value FROM settings WHERE key = 'landing_url'").get()?.value || '';

  const result = await chatJSON(
    `Craft a personalized outreach sequence for this lead. Return JSON with "sequence" array of objects, each having "step" (number), "channel" (email/linkedin/call), "delay_days", "subject" (if email), "message", and "goal".

Lead:
- Name: ${lead.name}
- Company: ${lead.company || 'Unknown'}
- Title: ${lead.title || 'Unknown'}
- Source: ${lead.source}
${input.context ? `- Context: ${input.context}` : ''}
${input.valueProposition ? `- Our value proposition: ${input.valueProposition}` : ''}
${input.ctaUrl || landingUrl ? `- CTA/Landing page URL: ${input.ctaUrl || landingUrl}` : ''}

Create a 4-5 step sequence that feels personal, not automated.
${input.ctaUrl || landingUrl ? `IMPORTANT: Include the URL "${input.ctaUrl || landingUrl}" naturally in at least 2 of the email messages as a CTA link. Each email step should give them a reason to click that link (e.g., "See a quick demo here: [URL]", "I put together something for you: [URL]").` : 'Include placeholder "[YOUR_LINK]" in email messages where a CTA link should go — the user will replace it with their actual URL.'}`,
    '',
    { maxTokens: 6000 }
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

Rules: Step 1 = email, delay_days=0. Then steps 2-3 on days 3, 7. Keep messages SHORT (2-3 sentences). 3 steps per lead.`,
      '',
      { maxTokens: 6000 }
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

    // Gather CRM data for context — capped to prevent token overflow
    const MAX_LEADS = 50;
    const MAX_DEALS = 20;
    const MAX_CAMPAIGNS = 15;
    const totalLeadCount = db.prepare(`SELECT COUNT(*) as c FROM leads${uw}`).get(...p).c;
    const allLeads = db.prepare(`SELECT id, name, email, company, title, source, score, status, notes FROM leads${uw} ORDER BY score DESC LIMIT ${MAX_LEADS}`).all(...p);
    const allCampaigns = db.prepare(`SELECT * FROM campaigns${uw} ORDER BY created_at DESC LIMIT ${MAX_CAMPAIGNS}`).all(...p);
    const allDeals = db.prepare(`
      SELECT p.*, l.name, l.company, l.email FROM pipeline p
      JOIN leads l ON p.lead_id = l.id WHERE 1=1${uf.replace('user_id', 'p.user_id')} ORDER BY p.deal_value DESC LIMIT ${MAX_DEALS}
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

    // All leads (capped)
    context += `\n=== LEADS (top ${allLeads.length} of ${totalLeadCount} by score) ===\n`;
    for (const l of allLeads) {
      context += `- ${l.name} | ${l.email} | ${l.company || 'N/A'} | ${l.title || 'N/A'} | Source: ${l.source} | Score: ${l.score} | Status: ${l.status}${l.notes ? ' | Notes: ' + l.notes.substring(0, 60) : ''}\n`;
    }
    if (totalLeadCount > MAX_LEADS) context += `... and ${totalLeadCount - MAX_LEADS} more leads not shown (use filters or ask about specific leads by name)\n`;

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
