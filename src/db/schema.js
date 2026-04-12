import crypto from 'crypto';

export function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      company TEXT,
      title TEXT,
      phone TEXT,
      source TEXT DEFAULT 'manual',
      score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','proposal','negotiation','won','lost')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('email','social','content','ad')),
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed')),
      subject TEXT,
      body TEXT,
      target_audience TEXT,
      scheduled_at DATETIME,
      sent_count INTEGER DEFAULT 0,
      open_count INTEGER DEFAULT 0,
      click_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaign_leads (
      campaign_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','opened','clicked','replied','bounced')),
      sent_at DATETIME,
      opened_at DATETIME,
      PRIMARY KEY (campaign_id, lead_id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS pipeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('prospecting','qualification','proposal','negotiation','closed_won','closed_lost')),
      deal_value REAL DEFAULT 0,
      probability INTEGER DEFAULT 0,
      expected_close_date DATE,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      campaign_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('email','call','meeting','note','task','ai_action')),
      description TEXT NOT NULL,
      outcome TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS generated_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('email','social_post','ad_copy','blog_outline','seo_keywords','landing_page')),
      prompt TEXT NOT NULL,
      content TEXT NOT NULL,
      campaign_id INTEGER,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','approved','published','archived')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      input TEXT,
      output TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS outreach_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      step INTEGER DEFAULT 1,
      channel TEXT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      goal TEXT,
      delay_days INTEGER DEFAULT 0,
      scheduled_at DATETIME,
      sent_at DATETIME,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','skipped','failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS ai_cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      task_type TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('superadmin','user')),
      display_name TEXT,
      budget_limit REAL DEFAULT 0,
      monthly_system_cost REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_logic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      code_ref TEXT,
      content TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default settings if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM settings').get();
  if (count.c === 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insert.run('ai_provider', 'anthropic');
    insert.run('ai_model', 'claude-sonnet-4-20250514');
    insert.run('api_key', '');
    insert.run('smtp_host', 'smtp.gmail.com');
    insert.run('smtp_port', '587');
    insert.run('smtp_user', '');
    insert.run('smtp_pass', '');
    insert.run('from_email', '');
    insert.run('admin_password', 'admin123');
    insert.run('stripe_secret_key', '');
    insert.run('stripe_publishable_key', '');
    insert.run('ai_credit_balance', '5.00');
  }

  // Ensure admin_password exists for existing DBs
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_password', 'admin123')").run();

  // Add budget_limit column to campaigns if missing
  try { db.exec('ALTER TABLE campaigns ADD COLUMN budget_limit REAL DEFAULT 0'); } catch (e) { /* already exists */ }

  // Add plan column to users if missing
  try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'starter'"); } catch (e) { /* already exists */ }
  // Set superadmin to business plan
  db.prepare("UPDATE users SET plan = 'business' WHERE role = 'superadmin' AND (plan IS NULL OR plan = 'starter')").run();

  // Add user_id to all data tables
  const tablesNeedingUserId = ['leads', 'campaigns', 'pipeline', 'activities', 'generated_content', 'agent_tasks', 'ai_cost_log', 'outreach_queue'];
  for (const table of tablesNeedingUserId) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER DEFAULT 1`); } catch (e) { /* already exists */ }
  }

  // Seed default superadmin
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (userCount.c === 0) {
    const hash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare(
      `INSERT INTO users (username, email, password_hash, role, display_name, budget_limit)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('admin', 'admin@localhost', hash, 'superadmin', 'Super Admin', 0);
  }

  // Seed system logic from codebase on every startup (auto-update)
  seedSystemLogic(db);
}

function seedSystemLogic(db) {
  db.exec('DELETE FROM system_logic');

  const insert = db.prepare(`
    INSERT INTO system_logic (topic, title, description, code_ref, content, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const entries = [
    // --- AI Engine ---
    ['AI Engine', 'AI Agent Core', 'Central AI orchestrator — routes tasks to specialized handlers',
      'src/services/ai-agent.js',
      'The AI agent is the brain of the system. It receives a task type and input, logs the task to the database, dispatches to the correct handler (score_lead, generate_email, etc.), and records the result or error.\n\nKey functions:\n- runAgent(taskType, input) — entry point, logs to agent_tasks table\n- executeTask() — dispatcher mapping task types to handlers\n- chat() / chatJSON() — low-level Claude API calls\n\nThe client and model are read dynamically from the settings DB on every call so changes in Settings take effect immediately.', 1],

    ['AI Engine', 'Lead Scoring (AI)', 'Scores leads 0-100 using profile + activity history',
      'src/services/ai-agent.js → scoreLeadTask()',
      'Fetches the lead profile and last 20 activities from the DB. Sends them to Claude asking for a JSON response with score, reasoning, and recommended_action. Updates the lead\'s score in the DB and logs an ai_action activity.', 2],

    ['AI Engine', 'Lead Qualification (AI)', 'BANT framework qualification via Claude',
      'src/services/ai-agent.js → qualifyLeadTask()',
      'Uses Budget/Authority/Need/Timeline framework. Claude returns a qualified boolean, bant_score (each 0-25), total_score, qualification_notes, and next_steps. Updates lead status to "qualified" or "contacted" accordingly.', 3],

    ['AI Engine', 'Outreach Sequence (AI)', 'Generates multi-step personalized outreach plans',
      'src/services/ai-agent.js → craftOutreachTask()',
      'Generates a 4-5 step outreach sequence with channel (email/linkedin/call), delay_days, subject, message, and goal for each step. Takes the lead profile and optional value proposition as context.', 4],

    ['AI Engine', 'Content Generation (AI)', 'Email, social, ad copy, SEO keyword generation',
      'src/services/ai-agent.js → generateEmailTask / generateSocialTask / generateAdTask / generateSeoTask',
      'Four generators:\n- Email: subject, preview_text, body_html, body_text\n- Social: post_text, hashtags, best_time_to_post, engagement_tips\n- Ad: headline_options, description_options, cta_options, targeting_suggestions\n- SEO: primary_keywords, long_tail_keywords, content_ideas, meta_description\n\nAll results are saved to the generated_content table.', 5],

    ['AI Engine', 'Pipeline Analysis (AI)', 'Health score, forecasts, bottleneck detection',
      'src/services/ai-agent.js → analyzePipelineTask()',
      'Aggregates all pipeline deals by stage, sends the summary + individual deal details to Claude. Returns health_score (0-100), bottlenecks array, recommendations array, revenue forecast (optimistic/realistic/pessimistic), and priority_deals to focus on.', 6],

    ['AI Engine', 'Freeform Chat', 'Conversational AI assistant with CRM context',
      'src/services/ai-agent.js → freeformChat()',
      'Injects current CRM stats (lead count, open deals, active campaigns) into the system prompt so Claude can give context-aware advice. Used by the AI Assistant chat page.', 7],

    // --- Data Layer ---
    ['Data Layer', 'Database Setup', 'SQLite with WAL mode and foreign keys',
      'src/db/index.js',
      'Uses better-sqlite3. DB file stored at data/agent.db. WAL journal mode for concurrent reads. Foreign keys enforced. The data/ directory is auto-created on startup.', 10],

    ['Data Layer', 'Schema — Leads', 'Lead profiles with scoring and status tracking',
      'src/db/schema.js → leads table',
      'Fields: name, email (unique), company, title, phone, source, score (0-100), status (new → contacted → qualified → proposal → negotiation → won/lost), notes. Timestamps for created_at and updated_at.', 11],

    ['Data Layer', 'Schema — Pipeline', 'Sales deals linked to leads with stage tracking',
      'src/db/schema.js → pipeline table',
      'Fields: lead_id (FK), stage (prospecting → qualification → proposal → negotiation → closed_won/closed_lost), deal_value, probability (0-100%), expected_close_date, notes. Pipeline stage changes auto-sync to lead status.', 12],

    ['Data Layer', 'Schema — Campaigns', 'Marketing campaigns with performance metrics',
      'src/db/schema.js → campaigns + campaign_leads tables',
      'Campaign types: email, social, content, ad. Statuses: draft → active → paused → completed. campaign_leads junction table tracks per-lead delivery status (pending/sent/opened/clicked/replied/bounced) with timestamps.', 13],

    ['Data Layer', 'Schema — Activities', 'Activity log for all lead interactions',
      'src/db/schema.js → activities table',
      'Types: email, call, meeting, note, task, ai_action. Each activity links to a lead and optionally a campaign. ai_action type is used for AI-generated entries (scoring, qualification, outreach).', 14],

    ['Data Layer', 'Schema — Generated Content', 'AI-generated content storage',
      'src/db/schema.js → generated_content table',
      'Types: email, social_post, ad_copy, blog_outline, seo_keywords, landing_page. Stores the prompt, full JSON content, optional campaign link, and status (draft/approved/published/archived).', 15],

    ['Data Layer', 'Schema — Settings', 'Key-value config store',
      'src/db/schema.js → settings table',
      'Stores: ai_provider, ai_model, api_key, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, admin_password. Read dynamically by the AI agent and email service. Admin password protects the System Logic page.', 16],

    // --- API Layer ---
    ['API Layer', 'Leads API', 'Full CRUD + AI-powered endpoints',
      'src/routes/leads.js',
      'Endpoints:\n- GET /api/leads — list with filters (status, minScore, source, search)\n- GET /api/leads/:id — single lead\n- POST /api/leads — create\n- PUT /api/leads/:id — update\n- DELETE /api/leads/:id — delete\n- GET /api/leads/:id/activities — activity history\n- POST /api/leads/:id/activities — log activity\n- POST /api/leads/:id/score — AI scoring\n- POST /api/leads/:id/qualify — AI BANT qualification\n- POST /api/leads/:id/outreach — AI outreach sequence', 20],

    ['API Layer', 'Pipeline API', 'Deal management + AI analysis',
      'src/routes/pipeline.js',
      'Endpoints:\n- GET /api/pipeline — list with filters (stage, minValue)\n- GET /api/pipeline/stats — aggregated pipeline stats\n- POST /api/pipeline — create deal\n- PUT /api/pipeline/:id — update (auto-syncs lead status)\n- DELETE /api/pipeline/:id — delete\n- POST /api/pipeline/analyze — AI pipeline analysis', 21],

    ['API Layer', 'Campaigns API', 'Campaign CRUD + email delivery',
      'src/routes/campaigns.js',
      'Endpoints:\n- GET /api/campaigns — list with filters\n- POST /api/campaigns — create\n- PUT /api/campaigns/:id — update\n- DELETE /api/campaigns/:id — delete\n- POST /api/campaigns/:id/leads — assign leads\n- POST /api/campaigns/:id/send — send email campaign via SMTP', 22],

    ['API Layer', 'Agent API', 'AI content generation + chat',
      'src/routes/agent.js',
      'Endpoints:\n- POST /api/agent/chat — freeform AI chat\n- POST /api/agent/generate/email — generate email\n- POST /api/agent/generate/social — generate social post\n- POST /api/agent/generate/ad — generate ad copy\n- POST /api/agent/generate/seo — generate SEO strategy\n- POST /api/agent/suggest-actions — AI action suggestions\n- GET /api/agent/tasks — recent AI task log\n- GET /api/agent/content — generated content list', 23],

    ['API Layer', 'Settings API', 'Configuration management + AI connection test',
      'src/routes/settings.js',
      'Endpoints:\n- GET /api/settings — read all (masks API key and SMTP password)\n- PUT /api/settings — update (skips masked values to avoid overwrite)\n- POST /api/settings/test-ai — tests Claude API connection with current key + model', 24],

    // --- Services ---
    ['Services', 'Leads Service', 'Lead data access with filtering, stats, activities',
      'src/services/leads.js',
      'Methods: getAll(filters), getById(id), create(lead), update(id, data), delete(id), getActivities(leadId), addActivity(leadId, activity), getStats(). Stats include total, byStatus, bySource, averageScore, recentLeads, topLeads.', 30],

    ['Services', 'Pipeline Service', 'Deal management with stage-to-status sync',
      'src/services/pipeline.js',
      'Methods: getAll(filters), getById(id), create(deal), update(id, data), delete(id), getStats(). On stage update, the linked lead\'s status is automatically synced (e.g., stage=closed_won sets lead status=won). Stats include weighted pipeline value and win rate.', 31],

    ['Services', 'Campaigns Service', 'Campaign management + SMTP email delivery',
      'src/services/campaigns.js',
      'Methods: getAll(filters), getById(id), create(campaign), update(id, data), delete(id), addLeads(campaignId, leadIds), sendCampaign(campaignId), getStats(). sendCampaign iterates leads, sends via nodemailer, updates campaign_leads status, and logs activities.', 32],

    // --- Frontend ---
    ['Frontend', 'SPA Architecture', 'Client-side routing with render/afterRender pattern',
      'public/app.js',
      'Single-page app. navigate(page) sets currentPage and calls render(). render() outputs sidebar + page skeleton + modal. afterRender() loads data async and fills the page. No framework — vanilla JS with template literals.', 40],

    ['Frontend', 'Dashboard Page', 'Overview with stats, top leads, recent activity',
      'public/app.js → loadDashboard()',
      'Shows 4 stat cards (total leads, qualified, pipeline value, active campaigns), top leads table with score bars, recent activity feed, and quick-action buttons for content generation and AI tools.', 41],

    ['Frontend', 'Leads Page', 'Lead table with inline AI actions',
      'public/app.js → loadLeads()',
      'Table view with all leads. Each row has AI Score, Qualify, Outreach, Edit, Delete buttons. Supports CSV bulk import. AI results display in modal overlays.', 42],

    ['Frontend', 'Pipeline Page', 'Kanban board with 6 stage columns',
      'public/app.js → loadPipeline()',
      'Visual board: Prospecting → Qualification → Proposal → Negotiation → Closed Won → Closed Lost. Each card shows name, company, deal value, probability. Stats bar shows open deals, value, weighted pipeline, win rate.', 43],

    ['Frontend', 'Campaigns Page', 'Campaign management with AI email generation',
      'public/app.js → loadCampaigns()',
      'List view with send capability for email campaigns. Campaign editor has "Generate with AI" button that auto-fills subject and body.', 44],

    ['Frontend', 'AI Content Page', 'Content generation interface',
      'public/app.js → loadContent()',
      'Four generators: Email, Social Post, Ad Copy, SEO Keywords. Each opens a modal form, sends to the agent API, and displays formatted results. All content saved to DB.', 45],

    ['Frontend', 'AI Chat Page', 'Conversational assistant',
      'public/app.js → renderChatPage()',
      'Chat interface with message bubbles. Quick-start buttons for common queries. Messages sent to /api/agent/chat with CRM context injected server-side.', 46],

    ['Frontend', 'Settings Page', 'AI model, API key, and SMTP configuration',
      'public/app.js → loadSettings()',
      'API key input with show/hide toggle. Model selector (Sonnet/Opus/Haiku). Connection test button. SMTP config for email sending. Green/red indicator for API key status.', 47],

    // --- Infrastructure ---
    ['Infrastructure', 'Express Server', 'HTTP server with static files and SPA fallback',
      'src/server.js',
      'Express app with CORS, JSON parsing, static file serving from public/. Routes mounted at /api/*. Dashboard endpoint aggregates stats inline. SPA fallback serves index.html for all unmatched routes.', 50],

    ['Infrastructure', 'Configuration', 'Environment variables + dynamic DB settings',
      'src/config/index.js + .env.example',
      'Reads PORT, ANTHROPIC_API_KEY, and SMTP_* from .env. AI agent also reads settings from the DB at runtime so changes via the Settings page take effect without restart.', 51],

    ['Infrastructure', 'Seed Data', 'Sample data for development/demo',
      'src/db/seed.js',
      'Seeds 10 leads, 5 campaigns, 8 pipeline deals, 10 activities, and campaign-lead associations. Run with: npm run seed', 52],
  ];

  for (const entry of entries) {
    insert.run(...entry);
  }
}
