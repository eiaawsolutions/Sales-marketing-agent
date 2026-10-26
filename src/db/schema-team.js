// Seats. A teammate is a user row whose account_owner_id points at the paying
// account; it has its own login, password, 2FA and sessions, and works on the
// owner's data (middleware/auth.js actAsAccount). Deleting the owner deletes
// its teammates (ON DELETE CASCADE, and explicitly in retention.js).
export function migrateTeam(db) {
  try { db.exec('ALTER TABLE users ADD COLUMN account_owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE'); } catch (e) { /* exists */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_account_owner ON users(account_owner_id)');
}
