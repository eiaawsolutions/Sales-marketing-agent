import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SA_DB_PATH points the whole app at a throwaway database. Production never sets
// it, so the default below is unchanged. Without it the services — which all
// import this singleton — could only ever be exercised against the real
// data/agent.db, which is why none of them had tests.
const DB_PATH = process.env.SA_DB_PATH || path.join(__dirname, '..', '..', 'data', 'agent.db');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initializeDatabase(db);

export default db;
