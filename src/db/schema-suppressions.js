// Email suppression list (unsubscribes).
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
}
