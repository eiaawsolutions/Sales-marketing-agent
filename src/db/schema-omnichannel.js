// Omnichannel lead funnel — schema + migrations.
//
// Lives outside schema.js only because schema.js is already ~570 lines and half
// of it is the system_logic seed. Everything here follows the same conventions:
// idempotent `try { ALTER } catch {}` for additive columns, and the SQLite
// table-rebuild dance when a constraint must change.
//
// Called from initializeDatabase() AFTER the base tables exist.
//
// ── The shape ───────────────────────────────────────────────────────────────
//
//   lead_sources        a connection the user created ("my Zapier hook").
//                       Carries its own ingest key + secret. The key IS the
//                       tenant routing — no env-var owner map.
//
//   lead_inbox          staging. Raw inbound lands here first, gets deduped,
//                       scored, and only then promoted into `leads`.
//                       (Pipedrive Leads Inbox / Salesforce Lead object.)
//
//   lead_touchpoints    append-only. Every time a known person shows up again
//                       from any channel. Powers first-touch vs last-touch.
//
//   segments            saved AND-of-ORs filters over leads.
//   segment_members     materialised membership (static segments + snapshots).
//
//   lead_scoring_rules  deterministic, free, runs on every lead.
//   lead_settings       per-tenant thresholds.

export function migrateOmnichannel(db) {
  // Order matters. addLeadColumns() adds `REFERENCES lead_sources(id)`, and
  // SQLite accepts that DDL against a missing table only to fail at the first
  // INSERT with "no such table: main.lead_sources". Create the target first.
  rebuildLeadsForOmnichannel(db);
  createSourceTables(db);
  createSegmentTables(db);
  createScoringTables(db);
  addLeadColumns(db);
  resolveEmailCaseDuplicates(db);
  createIndexes(db);
}

// ---------------------------------------------------------------------------
// 1. Rebuild `leads`: drop the global UNIQUE on email, allow NULL email.
//
// The original DDL was `email TEXT UNIQUE NOT NULL`, written before `user_id`
// existed. Two consequences, both live bugs:
//
//   a) Two tenants can never hold the same lead. The AI generator "handled"
//      this by UPDATE-ing the colliding row's user_id — silently transferring
//      another tenant's lead record to the caller.
//   b) A phone-only or LinkedIn-only lead cannot be stored at all, so the AI
//      path invented `<something>@noemail.leads.local` pseudo-emails, which
//      later needed a dedicated cleanup endpoint to purge.
//
// Both die here. Uniqueness becomes per-tenant and case-insensitive, expressed
// as a partial index so multiple NULL/'' emails coexist under one tenant.
//
// The rebuild is safe: children (campaign_leads, pipeline, activities,
// appointments, outreach_queue) reference `leads` by name. We DROP the old
// table rather than rename it, so their FK clauses are never rewritten, and
// `ALTER TABLE leads_new RENAME TO leads` re-points them. foreign_keys is OFF
// for the swap — matching the existing campaigns-CHECK rebuild in schema.js.
// Verified against a copy of the production DB: row counts, child FKs,
// foreign_key_check, and sqlite_sequence all survive intact.
// ---------------------------------------------------------------------------
function rebuildLeadsForOmnichannel(db) {
  try {
    const def = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'leads'").get();
    if (!def?.sql) return;
    // Idempotency probe: the old DDL is the only one with this exact clause.
    if (!/email\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i.test(def.sql)) return;

    // AUTOINCREMENT high-water mark. `INSERT INTO leads_new SELECT ...` resets
    // sqlite_sequence to MAX(id) of the surviving rows, so if any lead was ever
    // deleted the counter walks BACKWARDS and the next inserts reuse dead IDs.
    // A stale campaign_leads / outreach_queue / activities row still pointing at
    // dead lead #22 would then silently re-attach to a brand-new person.
    // Capture it now, restore it after the swap.
    const priorSeq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'leads'").get()?.seq ?? 0;

    db.exec('DROP TABLE IF EXISTS leads_new');
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE leads_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT,
          company TEXT,
          title TEXT,
          phone TEXT,
          source TEXT DEFAULT 'manual',
          score INTEGER DEFAULT 0,
          status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','proposal','negotiation','won','lost')),
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER DEFAULT 1
        );
      `);
      const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
      const target = ['id', 'name', 'email', 'company', 'title', 'phone', 'source',
        'score', 'status', 'notes', 'created_at', 'updated_at', 'user_id'];
      const safe = target.filter(c => cols.includes(c));
      db.exec(`INSERT INTO leads_new (${safe.join(',')}) SELECT ${safe.join(',')} FROM leads;`);
      db.exec('DROP TABLE leads;');
      db.exec('ALTER TABLE leads_new RENAME TO leads;');

      // Restore the high-water mark so deleted IDs are never handed out again.
      //
      // sqlite_sequence is declared `CREATE TABLE sqlite_sequence(name,seq)` —
      // no PK, no UNIQUE. `INSERT OR REPLACE` therefore APPENDS a second row for
      // 'leads' rather than replacing the first, leaving two conflicting entries.
      // UPDATE the row the RENAME just carried over; only INSERT if absent.
      const newMax = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM leads').get().m;
      const restored = Math.max(priorSeq, newMax);
      if (restored > 0) {
        const existing = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'leads'").get();
        if (existing) {
          db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'leads'").run(restored);
        } else {
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('leads', ?)").run(restored);
        }
      }

      console.log(
        `[migration] leads rebuilt: email is now nullable and unique per-tenant, not globally ` +
        `(autoincrement high-water mark held at ${restored})`
      );
    } finally {
      db.pragma('foreign_keys = ON');
    }
  } catch (e) {
    console.error('[migration] leads rebuild failed:', e.message);
    throw e; // A half-rebuilt leads table must not boot the app.
  }
}

// ---------------------------------------------------------------------------
// 2. Additive columns on leads.
//
// `source` (free text) stays — checkPlanLimit() counts `source = 'ai_generated'`
// and campaigns/UI read it. `source_id` is the new first-class FK. We keep both
// deliberately rather than break the plan-limit query.
//
// first_source_id is IMMUTABLE once written (first touch). last_source_id moves
// on every subsequent touch. That split is the HubSpot/Pipedrive convention and
// it is what makes per-source funnel attribution honest.
// ---------------------------------------------------------------------------
function addLeadColumns(db) {
  const columns = [
    "ALTER TABLE leads ADD COLUMN source_id INTEGER REFERENCES lead_sources(id)",
    "ALTER TABLE leads ADD COLUMN first_source_id INTEGER REFERENCES lead_sources(id)",
    "ALTER TABLE leads ADD COLUMN last_source_id INTEGER REFERENCES lead_sources(id)",
    "ALTER TABLE leads ADD COLUMN email_normalized TEXT",
    "ALTER TABLE leads ADD COLUMN phone_normalized TEXT",
    "ALTER TABLE leads ADD COLUMN linkedin_normalized TEXT",
    "ALTER TABLE leads ADD COLUMN linkedin_url TEXT",
    "ALTER TABLE leads ADD COLUMN company_website TEXT",
    "ALTER TABLE leads ADD COLUMN lead_type TEXT",
    "ALTER TABLE leads ADD COLUMN segment_type TEXT",
    "ALTER TABLE leads ADD COLUMN confidence_score TEXT",
    "ALTER TABLE leads ADD COLUMN buying_signal TEXT",
    "ALTER TABLE leads ADD COLUMN verification_sources TEXT",
    "ALTER TABLE leads ADD COLUMN score_breakdown TEXT",
    "ALTER TABLE leads ADD COLUMN qualified_at DATETIME",
    "ALTER TABLE leads ADD COLUMN touch_count INTEGER NOT NULL DEFAULT 1",
  ];
  for (const sql of columns) {
    try { db.exec(sql); } catch (e) { /* column already exists */ }
  }

  // Backfill normalized keys for rows written before this migration.
  //
  // This must run EXACTLY ONCE. resolveEmailCaseDuplicates() deliberately clears
  // email_normalized on case-variant duplicates, and "email_normalized IS NULL
  // AND email IS NOT NULL" describes precisely those rows — so an unguarded
  // re-run would try to restore the key it just removed and hit the UNIQUE
  // index. Guard with a settings flag, and use UPDATE OR IGNORE so that even
  // without the flag (e.g. a caller invoking migrateOmnichannel directly, as the
  // migration test does) a collision skips the row instead of throwing.
  const BACKFILL_FLAG = 'omnichannel_key_backfill_v1';
  let alreadyDone = false;
  try {
    alreadyDone = db.prepare('SELECT value FROM settings WHERE key = ?').get(BACKFILL_FLAG)?.value === '1';
  } catch (e) { /* settings table may not exist when called standalone */ }
  if (alreadyDone) return;

  try {
    const rows = db.prepare(
      "SELECT id, email, phone FROM leads WHERE email_normalized IS NULL AND (email IS NOT NULL OR phone IS NOT NULL)"
    ).all();
    if (rows.length) {
      const upd = db.prepare('UPDATE OR IGNORE leads SET email_normalized = ?, phone_normalized = ? WHERE id = ?');
      let applied = 0;
      const run = db.transaction(() => {
        for (const r of rows) {
          const em = typeof r.email === 'string' && r.email.includes('@')
            ? r.email.trim().toLowerCase() : null;
          const ph = typeof r.phone === 'string'
            ? (r.phone.replace(/\D/g, '') || null) : null;
          applied += upd.run(em, ph && ph.length >= 7 && ph.length <= 15 ? ph : null, r.id).changes;
        }
      });
      run();
      console.log(`[migration] backfilled normalized keys on ${applied}/${rows.length} leads`);
    }
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(BACKFILL_FLAG);
    } catch (e) { /* no settings table when called standalone */ }
  } catch (e) {
    console.error('[migration] lead key backfill failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// 2b. Make idx_leads_user_email buildable.
//
// The old global UNIQUE(email) used BINARY collation, so `Amos@Acme.com` and
// `amos@acme.com` could BOTH exist. Once normalized they collide, and the new
// per-tenant UNIQUE index would fail to build — leaving us with no uniqueness
// at all, silently. Rather than let that happen, keep the earliest row's
// normalized key and unset it on the later ones. The raw `email` column is left
// untouched, so nothing is lost: the rows are still there, still contactable,
// and now flagged for a human to merge.
// ---------------------------------------------------------------------------
function resolveEmailCaseDuplicates(db) {
  try {
    const dupes = db.prepare(`
      SELECT user_id, email_normalized, COUNT(*) AS c, MIN(id) AS keep_id
        FROM leads
       WHERE email_normalized IS NOT NULL AND email_normalized <> ''
       GROUP BY user_id, email_normalized
      HAVING c > 1
    `).all();
    if (!dupes.length) return;

    const clear = db.prepare(`
      UPDATE leads
         SET email_normalized = NULL,
             notes = COALESCE(notes || char(10), '') ||
                     '[migration] Case-variant duplicate of lead #' || ? ||
                     ' — normalized email key cleared; merge these two manually.'
       WHERE user_id = ? AND email_normalized = ? AND id <> ?
    `);
    const run = db.transaction(() => {
      for (const d of dupes) clear.run(d.keep_id, d.user_id, d.email_normalized, d.keep_id);
    });
    run();
    console.warn(
      `[migration] ${dupes.length} case-variant duplicate email group(s) found. ` +
      `Kept the earliest lead in each; cleared the dedupe key on the rest and noted them. ` +
      `Groups: ${dupes.map(d => `user ${d.user_id}/${d.email_normalized} (${d.c} rows)`).join(', ')}`
    );
  } catch (e) {
    console.error('[migration] email duplicate resolution failed:', e.message);
    throw e; // Proceeding would build no unique index and lose tenant isolation.
  }
}

function createSourceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'webhook','zapier','google_ads','calendly','email_inbound',
        'web_form','chatbot','voice','csv','apollo','ai_websearch','manual'
      )),
      name TEXT NOT NULL,

      -- Public, unguessable, appears in the ingest URL. This is the tenant
      -- routing key: possession of it decides which user_id a lead lands on.
      ingest_key TEXT NOT NULL UNIQUE,

      -- AES-256-GCM via utils/crypto.js. NULL for 'public' and 'internal' modes.
      secret_enc TEXT,

      --  hmac      X-EIAAW-Signature: t=<unix>,v1=<hex>  over "t.rawBody". Replay window.
      --  token     X-Ingest-Token: <secret>, timing-safe compare. For Zapier/Make/n8n,
      --            which cannot easily compute an HMAC.
      --  provider  adapter-specific (Google google_key in body, Calendly HMAC
      --            header, Resend/Svix signature).
      --  public    ingest_key only. For embeds whose key is necessarily visible
      --            in client-side JS (web_form, chatbot). NOT authentication —
      --            defended by rate limit + origin check. Never auto-promotes.
      --  internal  never reachable over HTTP. Server-side callers only
      --            (apollo, ai_websearch, csv, manual, voice).
      auth_mode TEXT NOT NULL DEFAULT 'hmac'
        CHECK(auth_mode IN ('hmac','token','provider','public','internal')),

      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','disabled')),

      -- 0 = land in the inbox for review. 1 = promote straight to leads when the
      -- score clears the tenant threshold. Forced to 0 for auth_mode='public'.
      auto_promote INTEGER NOT NULL DEFAULT 0,

      health TEXT NOT NULL DEFAULT 'unknown' CHECK(health IN ('unknown','ok','error')),
      last_error TEXT,
      last_event_at DATETIME,
      received_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lead_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,

      -- Provider's own event id. Idempotency key: a redelivered webhook with the
      -- same external_id is a no-op, not a second lead.
      external_id TEXT,
      -- SHA-256 of the normalized identity triple. Used when the provider gives
      -- us no event id (most do not).
      dedupe_key TEXT,

      raw_payload TEXT,
      name TEXT, email TEXT, phone TEXT, company TEXT, title TEXT,
      linkedin_url TEXT, company_website TEXT, message TEXT,
      email_normalized TEXT, phone_normalized TEXT, linkedin_normalized TEXT,

      score INTEGER NOT NULL DEFAULT 0,
      score_breakdown TEXT,

      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','accepted','rejected','duplicate','error')),
      reject_reason TEXT,

      matched_lead_id INTEGER,   -- identity resolution found an existing lead
      promoted_lead_id INTEGER,  -- the lead row this became

      ip TEXT, user_agent TEXT,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lead_touchpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      source_id INTEGER,
      inbox_id INTEGER,
      channel TEXT NOT NULL,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      meta TEXT,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );
  `);
}

function createSegmentTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      -- dynamic: membership is the live result of the filter column.
      -- static:  membership is whatever is in segment_members.
      kind TEXT NOT NULL DEFAULT 'dynamic' CHECK(kind IN ('dynamic','static')),
      filter TEXT NOT NULL DEFAULT '{"match":"all","groups":[]}',
      last_count INTEGER DEFAULT 0,
      last_evaluated_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS segment_members (
      segment_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (segment_id, lead_id),
      FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE CASCADE,
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );
  `);
}

function createScoringTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_scoring_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      field TEXT NOT NULL,
      op TEXT NOT NULL,
      value TEXT,
      points INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lead_settings (
      user_id INTEGER PRIMARY KEY,
      -- Rule score at/above which we spend one AI call on BANT qualification.
      ai_qualify_threshold INTEGER NOT NULL DEFAULT 60,
      -- Rule score at/above which an auto_promote source skips inbox review.
      auto_promote_threshold INTEGER NOT NULL DEFAULT 40,
      -- Create a pipeline deal the moment a lead is AI-qualified.
      auto_create_deal INTEGER NOT NULL DEFAULT 1,
      default_deal_value REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function createIndexes(db) {
  // These three are correctness boundaries, not optimisations. Without
  // idx_leads_user_email a tenant can hold two rows for one person; without
  // idx_inbox_idempotency a redelivered webhook creates a duplicate lead. If
  // either cannot be built, the data is not in the shape the code assumes and
  // booting anyway would be worse than crashing.
  const critical = [
    // Per-tenant, case-insensitive email uniqueness. Partial, so any number of
    // NULL / '' emails may coexist under one tenant (phone-only leads).
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_user_email
       ON leads(user_id, email_normalized)
       WHERE email_normalized IS NOT NULL AND email_normalized <> ''`,

    `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_user_linkedin
       ON leads(user_id, linkedin_normalized) WHERE linkedin_normalized IS NOT NULL`,

    // Webhook redelivery is a no-op, enforced by the DB not by a race-prone read.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_idempotency
       ON lead_inbox(source_id, external_id) WHERE external_id IS NOT NULL`,
  ];

  const performance = [
    // Identity-resolution lookups. Non-unique: a shared office line legitimately
    // appears on several leads, and merging on phone alone is not allowed.
    `CREATE INDEX IF NOT EXISTS idx_leads_user_phone
       ON leads(user_id, phone_normalized) WHERE phone_normalized IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_leads_user_source ON leads(user_id, last_source_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_user_status ON leads(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_inbox_user_status ON lead_inbox(user_id, status, received_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_inbox_source ON lead_inbox(source_id, received_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_sources_user ON lead_sources(user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_touchpoints_lead ON lead_touchpoints(lead_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_touchpoints_source ON lead_touchpoints(source_id, occurred_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_segment_members_lead ON segment_members(lead_id)`,
    `CREATE INDEX IF NOT EXISTS idx_scoring_rules_user ON lead_scoring_rules(user_id, enabled, sort_order)`,
  ];

  for (const sql of critical) {
    try {
      db.exec(sql);
    } catch (e) {
      console.error('[migration] CRITICAL index failed:', sql.trim().split('\n')[0], '→', e.message);
      throw e;
    }
  }
  for (const sql of performance) {
    try { db.exec(sql); } catch (e) {
      console.error('[migration] index failed:', sql.trim().split('\n')[0], '→', e.message);
    }
  }
}
