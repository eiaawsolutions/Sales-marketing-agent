#!/usr/bin/env node
// Writes src/version.json with the current git commit SHA and a build
// timestamp. Run this IMMEDIATELY before `railway up` so the SHA ships
// inside the uploaded snapshot and is served by /api/health at runtime.
// See src/version.js for why this exists (CLI deploys don't get Railway's
// RAILWAY_GIT_COMMIT_SHA).
//
// IMPORTANT: deploy with `railway up --detach --no-gitignore` (see the
// `deploy` npm script). src/version.json is in .gitignore, and by default
// `railway up` honours .gitignore and would DROP it from the upload —
// then /api/health reports gitSha:"unknown". --no-gitignore makes Railway
// use .dockerignore instead, which intentionally does NOT exclude it.
//
// Usage:  npm run deploy      (= stamp + railway up --detach --no-gitignore)

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'src', 'version.json');

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const gitSha = git('rev-parse HEAD') || 'unknown';
const dirty = git('status --porcelain') !== '';
// ISO-8601 UTC; Date is fine here — this is a build tool, not app runtime.
const builtAt = new Date().toISOString();

const payload = { gitSha, dirty, builtAt };
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');

console.log(`Stamped src/version.json → sha=${gitSha.slice(0, 12)} dirty=${dirty} builtAt=${builtAt}`);
if (dirty) {
  console.warn('WARNING: working tree is dirty — the stamped SHA may not match what you are deploying. Commit first.');
}
