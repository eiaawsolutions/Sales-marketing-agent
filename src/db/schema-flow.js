// The brief-to-meeting flow: what the agent keeps so a person can see why it
// did something.
//
//   leads.score_detail — the BANT breakdown behind a lead's score (four
//     factors, 0–25 each, a note per factor, the overall reasoning and the
//     next step), as JSON. The score column stays the single number lists
//     sort by; it is always the sum of the four factors.
//
//   account_profiles: who the account sells to — ideal_client (a sentence),
//     target_roles / target_sectors / target_regions (JSON arrays) and
//     company_size (a band). Searches, scores and campaign audiences are
//     written from these.
//
//   outreach_queue.highlights — which phrases of a draft came from the lead's
//     public signals and which from the brief: [{ text, from: 'lead'|'brief' }].
//     Only phrases found verbatim in the message are kept.
//
//   account_profiles.booking_link / calendly_token — the calendar real
//     meeting times are offered from (calendar.js). The token is encrypted
//     and never returned by the API.
//
// Plain ADD COLUMNs only: nothing here rebuilds a table.

export function migrateFlow(db) {
  addColumn(db, 'leads', 'score_detail', 'TEXT');

  for (const col of ['ideal_client', 'target_roles', 'target_sectors', 'target_regions', 'company_size']) {
    addColumn(db, 'account_profiles', col, 'TEXT');
  }

  addColumn(db, 'outreach_queue', 'highlights', 'TEXT');

  // The account's booking calendar (calendar.js): a Cal.com or Calendly link,
  // and for Calendly the account's personal access token, encrypted.
  addColumn(db, 'account_profiles', 'booking_link', 'TEXT');
  addColumn(db, 'account_profiles', 'calendly_token', 'TEXT');

  // Prospects' replies (replies.js, inbound-replies.js): read automatically
  // from the reply address, or pasted in. Each keeps its label, what the agent
  // did, and the drafted answer waiting for a person. A reply that is not
  // addressed to one of our signed reply addresses is never stored.
  //   status: received → processing → new (waiting for a person) →
  //           answered | dismissed; failed is retried; unmatched is dropped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('inbound', 'pasted')),
      provider_email_id TEXT UNIQUE,
      message_id TEXT,
      from_address TEXT,
      to_address TEXT,
      subject TEXT,
      body TEXT,
      intent TEXT,
      confidence REAL,
      summary TEXT,
      next_step TEXT,
      actions TEXT,
      suggested_subject TEXT,
      suggested_body TEXT,
      status TEXT NOT NULL DEFAULT 'received'
        CHECK(status IN ('received', 'processing', 'new', 'answered', 'dismissed', 'unmatched', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      forwarded_at DATETIME,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      handled_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_replies_user ON replies(user_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status);
  `);
  // How many scheduled messages the reply cancelled when it arrived.
  addColumn(db, 'replies', 'stopped_count', 'INTEGER NOT NULL DEFAULT 0');

  // The Monday brief, pipeline reviews asked for in the app, and the monthly
  // report (weekly-brief.js, monthly-report.js). facts are the numbers; the
  // narrative is the assistant's reading of them. A weekly or monthly row is
  // unique per period, so a rerun of the job never emails twice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('weekly', 'review', 'monthly')),
      period TEXT NOT NULL,
      facts TEXT NOT NULL,
      narrative TEXT,
      emailed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_period ON briefs(user_id, kind, period) WHERE kind <> 'review';
    CREATE INDEX IF NOT EXISTS idx_briefs_user ON briefs(user_id, created_at);
  `);
}

function addColumn(db, table, column, type) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
