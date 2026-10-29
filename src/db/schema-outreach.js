// Outreach approval, sending identity and the per-account brief.
//
// 1. outreach_queue gains two statuses:
//      draft   — written by the agent, waiting for a person to approve it
//      sending — claimed by one dispatcher; stops two runs sending it twice
//    plus approved_at / approved_by for the audit trail.
// 2. email_suppressions accepts 'bounce': a hard bounce stops every campaign
//    in the account, not just the one that bounced.
// 3. account_profiles: what the account sells and who it sends as. Outreach,
//    scoring, the voice assistant and meeting invites read from here instead
//    of describing EIAAW's own product.
//
// SQLite cannot ALTER a CHECK constraint, so (1) and (2) rebuild the table,
// following the leads rebuild in schema-omnichannel.js: foreign keys off for
// the swap, AUTOINCREMENT high-water mark held so a dead id is never reused.

import { fitLinkedinNote, LINKEDIN_NOTE_MAX } from '../utils/linkedin-note.js';

const OUTREACH_COLUMNS = ['id', 'campaign_id', 'lead_id', 'step', 'channel', 'subject', 'message', 'goal',
  'delay_days', 'scheduled_at', 'sent_at', 'status', 'created_at', 'user_id', 'provider_message_id',
  'approved_at', 'approved_by', 'claimed_at'];

const SUPPRESSION_COLUMNS = ['id', 'user_id', 'email_hash', 'reason', 'campaign_id', 'lead_id', 'created_at'];

// LinkedIn notes waiting to be sent that were written for the old 300 limit:
// cut to LinkedIn's 200 so a pasted note is not chopped off mid-sentence.
// Sent and skipped notes are history and stay as they were. Returns how many
// changed (none on every boot after the first).
export function fitUnsentLinkedinNotes(db) {
  const rows = db.prepare("SELECT id, message FROM outreach_queue WHERE channel = 'linkedin' AND status IN ('draft', 'pending')").all();
  const update = db.prepare("UPDATE outreach_queue SET message = ? WHERE id = ? AND status IN ('draft', 'pending')");
  let changed = 0;
  for (const r of rows) {
    if (String(r.message || '').length <= LINKEDIN_NOTE_MAX) continue;
    changed += update.run(fitLinkedinNote(r.message), r.id).changes;
  }
  return changed;
}

// Sends used to leave a lead at New, so the board and the pipeline review
// counted emailed leads as "not contacted yet". Moves every New lead that was
// written to — an email or LinkedIn note sent, a campaign email that reached
// them, or a send on its timeline (the campaign may since have been deleted) —
// to Contacted. Runs once: a lead someone later moves back to New stays there.
// Returns how many moved.
export function markWrittenToLeadsContacted(db) {
  const KEY = 'migration_written_to_contacted';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return 0;
  return db.transaction(() => {
    const { changes } = db.prepare(`
      UPDATE leads SET status = 'contacted', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'new' AND (
         EXISTS (SELECT 1 FROM outreach_queue oq JOIN campaigns c ON c.id = oq.campaign_id
                  WHERE oq.lead_id = leads.id AND c.user_id = leads.user_id AND oq.status = 'sent')
         OR EXISTS (SELECT 1 FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
                     WHERE cl.lead_id = leads.id AND c.user_id = leads.user_id
                       AND cl.status IN ('sent', 'opened', 'clicked', 'replied'))
         OR EXISTS (SELECT 1 FROM activities a
                     WHERE a.lead_id = leads.id AND a.user_id = leads.user_id
                       AND ((a.type = 'email' AND (a.description LIKE 'Sent campaign:%' OR a.description LIKE 'Auto-outreach Step%'))
                         OR (a.type = 'note' AND a.description LIKE 'LinkedIn connection note sent%'))))
    `).run();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now'))").run(KEY);
    return changes;
  })();
}

// LinkedIn notes marked sent before a note counted as the campaign's send left
// the lead at "pending" in that campaign's lead list. Moves them to sent, dated
// when the note went. Runs once. Returns how many moved.
export function markLinkedinNotesSentInCampaigns(db) {
  const KEY = 'migration_linkedin_notes_sent_in_campaigns';
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(KEY)) return 0;
  const sentNote = `FROM outreach_queue oq WHERE oq.campaign_id = campaign_leads.campaign_id AND oq.lead_id = campaign_leads.lead_id
                      AND oq.channel = 'linkedin' AND oq.status = 'sent'`;
  return db.transaction(() => {
    const { changes } = db.prepare(`
      UPDATE campaign_leads SET status = 'sent', sent_at = COALESCE(sent_at, (SELECT MIN(oq.sent_at) ${sentNote}))
       WHERE status = 'pending' AND EXISTS (SELECT 1 ${sentNote})
    `).run();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now'))").run(KEY);
    return changes;
  })();
}

export function migrateOutreach(db) {
  rebuild(db, {
    table: 'outreach_queue',
    needed: (sql) => !sql.includes("'draft'"),
    columns: OUTREACH_COLUMNS,
    ddl: `
      CREATE TABLE outreach_queue_new (
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
        status TEXT DEFAULT 'pending' CHECK(status IN ('draft','pending','sending','sent','skipped','failed')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER DEFAULT 1,
        provider_message_id TEXT,
        approved_at DATETIME,
        approved_by INTEGER,
        claimed_at DATETIME,
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      );`,
  });
  db.exec('CREATE INDEX IF NOT EXISTS idx_outreach_queue_provider_message_id ON outreach_queue(provider_message_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outreach_queue_due ON outreach_queue(status, scheduled_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outreach_queue_campaign_lead ON outreach_queue(campaign_id, lead_id)');

  rebuild(db, {
    table: 'email_suppressions',
    needed: (sql) => !sql.includes("'bounce'"),
    columns: SUPPRESSION_COLUMNS,
    ddl: `
      CREATE TABLE email_suppressions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        email_hash TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('unsubscribe','complaint','bounce','manual')),
        campaign_id INTEGER,
        lead_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, email_hash)
      );`,
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      business_name TEXT,
      sender_name TEXT,
      sender_title TEXT,
      reply_to_email TEXT,
      from_email TEXT,
      website TEXT,
      offer TEXT,
      proof_points TEXT,
      call_to_action TEXT,
      tone TEXT,
      meeting_link TEXT,
      voice_notes TEXT,
      outreach_approval INTEGER NOT NULL DEFAULT 1 CHECK(outreach_approval IN (0, 1)),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function rebuild(db, { table, needed, columns, ddl }) {
  const def = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
  if (!def?.sql || !needed(def.sql)) return;

  const priorSeq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? 0;
  db.exec(`DROP TABLE IF EXISTS ${table}_new`);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(ddl);
      const have = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      const cols = columns.filter(c => have.includes(c)).join(',');
      db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);

      // sqlite_sequence has no unique key: UPDATE the row the rename carried
      // over, INSERT only if there is none (see schema-omnichannel.js).
      const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m;
      const seq = Math.max(priorSeq, max);
      if (seq > 0) {
        const row = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table);
        if (row) db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(seq, table);
        else db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, seq);
      }
    })();
    console.log(`[migration] ${table} rebuilt with the new CHECK constraint`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
