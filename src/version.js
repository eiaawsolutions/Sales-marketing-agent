// Build/version metadata surfaced on /api/health so the deploy→refresh
// pipeline can assert it is talking to the RIGHT build before pushing the
// prompt to Retell.
//
// Why a file and not just an env var: this project deploys via
// `railway up --detach` (a CLI snapshot upload), NOT a GitHub trigger.
// Railway only populates RAILWAY_GIT_COMMIT_SHA for GitHub-triggered
// deploys, so on our deploys that env var is empty. Instead
// `scripts/stamp-version.js` writes src/version.json (git SHA + build time)
// into the snapshot right before `railway up`, so the SHA travels WITH the
// exact code that gets deployed and can never disagree with what is running.
//
// Resolution order: version.json (stamped) → RAILWAY_GIT_COMMIT_SHA env →
// GIT_SHA env → "unknown".

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let stamped = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
  stamped = JSON.parse(raw);
} catch {
  // No stamped file (e.g. local dev without a deploy stamp) — fall back to env.
  stamped = {};
}

export const GIT_SHA =
  stamped.gitSha ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_SHA ||
  'unknown';

export const BUILT_AT = stamped.builtAt || null;
