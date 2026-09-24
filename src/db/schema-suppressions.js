// Email suppression list (unsubscribes and spam complaints), plus the provider
// message ids that tie Resend's delivery webhooks back to one outreach send.
//
// One row per (sending account, recipient). The recipient is stored only as a
// SHA-256 of the normalised address: enough to block a send, nothing to leak.
// No foreign keys on purpose: an opt-out must outlive the lead, the campaign
// and the retention job that deletes them, or a re-imported contact would be
// emailed again. Never delete rows from here except on a verified request
// from the recipient to be contactable again.
export function migrateSuppressions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      email_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('unsubscribe','complaint','manual')),
      campaign_id INTEGER,
      lead_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, email_hash)
    );
  `);

  // Resend's email id for each outreach send (campaign send or follow-up), so
  // a webhook event resolves to exactly one send in one account.
  for (const table of ['campaign_leads', 'outreach_queue']) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN provider_message_id TEXT`); } catch (e) { /* exists */ }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_provider_message_id ON ${table}(provider_message_id)`);
  }
}
