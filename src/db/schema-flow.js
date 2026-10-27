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
// Plain ADD COLUMNs only: nothing here rebuilds a table.

export function migrateFlow(db) {
  addColumn(db, 'leads', 'score_detail', 'TEXT');

  for (const col of ['ideal_client', 'target_roles', 'target_sectors', 'target_regions', 'company_size']) {
    addColumn(db, 'account_profiles', col, 'TEXT');
  }
}

function addColumn(db, table, column, type) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
