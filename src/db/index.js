import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'agent.db');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

initializeDatabase(db);

export default db;
