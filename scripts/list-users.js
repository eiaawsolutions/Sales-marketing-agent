#!/usr/bin/env node
/** Read-only inspect of users table. Run via railway run. */
import db from '../src/db/index.js';
const users = db.prepare('SELECT id, username, email, role, plan, email_verified, created_at FROM users ORDER BY id').all();
console.log(`Total users: ${users.length}`);
for (const u of users) console.log(JSON.stringify(u));
