#!/usr/bin/env node
/**
 * Safe voice-prompt release: wait for the current Railway deploy to go live,
 * prove the RIGHT build is serving, then push the voice prompt to Retell —
 * and confirm what was pushed. This is steps 2-4 of the release procedure
 * (step 1, `npm run deploy`, is separate on purpose so a failed refresh
 * never re-triggers a build).
 *
 *   1. (you)  git commit && git push && npm run deploy
 *   2. (here) poll `railway deployment list` until the newest deploy = SUCCESS
 *   3. (here) GET /api/health — ABORT unless gitSha == local git HEAD
 *   4. (here) POST /api/voice/refresh-prompt-with-token, then cross-check the
 *             response's gitSha + promptSha against /api/health
 *
 * The load-bearing guard is step 3: the health gitSha must equal HEAD before
 * we touch Retell, so a stale/half-swapped container can never receive an old
 * prompt. Polling to SUCCESS is just patience — Railway only flips to SUCCESS
 * after its healthcheck (/api/health) passes, so SUCCESS already implies the
 * new container answered.
 *
 * Usage:   npm run release
 *   or:    node scripts/deploy-and-refresh.js
 *
 * Exit codes: 0 = refreshed & verified. Non-zero = aborted (nothing pushed to
 * Retell on any non-zero exit that happens before step 4).
 *
 * Env overrides:
 *   BASE_URL                 default https://sa.eiaawsolutions.com
 *   VOICE_REFRESH_TOKEN_FILE default C:\tmp\eiaaw_voice_refresh_token.txt
 *   VOICE_REFRESH_TOKEN      inline token (takes precedence over the file)
 *   RAILWAY_BIN              default "railway" (resolved on PATH)
 *   POLL_TIMEOUT_MS          default 480000 (8 min) — build+deploy window
 *   POLL_INTERVAL_MS         default 15000  (15 s)
 *   HTTP_TIMEOUT_MS          default 30000  (30 s) per request
 *   SKIP_POLL=1              skip step 2 (deploy already known live)
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const BASE_URL = (process.env.BASE_URL || 'https://sa.eiaawsolutions.com').replace(/\/$/, '');
const TOKEN_FILE = process.env.VOICE_REFRESH_TOKEN_FILE || 'C:\\tmp\\eiaaw_voice_refresh_token.txt';

// Resolve the Railway CLI robustly. npm-spawned subprocesses on Windows don't
// always inherit the PATH that resolves a bare `railway`, and the launchable
// file is `railway.cmd` (not `railway`), which execFile can't run without a
// shell. Honour RAILWAY_BIN, else probe the npm global dir, else fall back to
// a bare name run through a shell.
function resolveRailwayBin() {
  if (process.env.RAILWAY_BIN) return process.env.RAILWAY_BIN;
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null;
  const candidates = npmDir
    ? [path.join(npmDir, 'railway.cmd'), path.join(npmDir, 'railway.exe'), path.join(npmDir, 'railway')]
    : [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'railway.cmd' : 'railway';
}
const RAILWAY_BIN = resolveRailwayBin();

const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 480000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15000);
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AbortError so the top-level handler can exit cleanly. We deliberately do NOT
// call process.exit() from inside the async flow: doing so while a fetch's
// AbortController/socket handle is still closing trips a libuv assertion on
// Windows (UV_HANDLE_CLOSING) and crashes with code 127 instead of 1. Setting
// process.exitCode and letting the loop drain avoids that.
class ReleaseAbort extends Error {
  constructor(msg, code = 1) {
    super(msg);
    this.name = 'ReleaseAbort';
    this.code = code;
  }
}
function die(msg, code = 1) {
  throw new ReleaseAbort(msg, code);
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (e) {
    die(`could not read git HEAD: ${e.message}`);
  }
}

function readToken() {
  if (process.env.VOICE_REFRESH_TOKEN) return process.env.VOICE_REFRESH_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').replace(/[\r\n]+/g, '').trim();
  } catch (e) {
    die(`could not read refresh token from ${TOKEN_FILE} (or set VOICE_REFRESH_TOKEN): ${e.message}`);
  }
}

// Newest deployment (id + status) as reported by the Railway CLI JSON output.
// The CLI is a .cmd shim on Windows, which spawnSync can only run through a
// shell (execFile gets EINVAL). We therefore build ONE command string and use
// execSync — passing an args array with shell:true is what trips the DEP0190
// warning, so we avoid the array. The bin path is quoted for spaces; args are
// static literals (no injection surface).
const RAILWAY_CMD = `"${RAILWAY_BIN}" deployment list --json`;
function latestDeployment() {
  let out;
  try {
    out = execSync(RAILWAY_CMD, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    die(`\`${RAILWAY_BIN} deployment list --json\` failed — is the CLI installed and the project linked? ` +
      `Set RAILWAY_BIN to its full path if it isn't auto-detected.\n${e.message}`);
  }
  let arr;
  try {
    arr = JSON.parse(out);
  } catch {
    die(`could not parse deployment list JSON:\n${out.slice(0, 500)}`);
  }
  if (!Array.isArray(arr) || arr.length === 0) die('no deployments returned by Railway');
  return arr[0]; // newest first
}

async function httpJson(method, path, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function step2_pollUntilLive() {
  if (process.env.SKIP_POLL === '1') {
    console.log('• SKIP_POLL=1 — skipping deploy poll');
    return;
  }
  console.log(`\n[2/4] Polling Railway until the newest deploy is SUCCESS (timeout ${POLL_TIMEOUT_MS / 1000}s)…`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const d = latestDeployment();
    if (d.status !== last) {
      console.log(`  ${d.id?.slice(0, 8)} → ${d.status}`);
      last = d.status;
    }
    if (d.status === 'SUCCESS') return ok(`deploy ${d.id?.slice(0, 8)} is live`);
    if (['FAILED', 'CRASHED'].includes(d.status)) {
      die(`deploy ${d.id?.slice(0, 8)} ended ${d.status} — not refreshing Retell`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  die(`timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for SUCCESS`);
}

async function step3_assertBuild(expectedSha) {
  console.log(`\n[3/4] Asserting /api/health reports the deployed build…`);
  const h = await httpJson('GET', '/api/health');
  if (!h.ok || !h.json) die(`/api/health returned status ${h.status}: ${h.text.slice(0, 200)}`);
  const { gitSha, promptChars, promptSha, builtAt } = h.json;
  console.log(`  health: gitSha=${gitSha} promptChars=${promptChars} promptSha=${promptSha} builtAt=${builtAt}`);

  if (!gitSha || gitSha === 'unknown') {
    die(`/api/health gitSha is "${gitSha}". Did the deploy ship src/version.json? ` +
      `Deploy with \`npm run deploy\` (it passes --no-gitignore).`);
  }
  if (gitSha !== expectedSha) {
    die(`build mismatch — live gitSha ${gitSha} != local HEAD ${expectedSha}. ` +
      `The new build isn't serving yet, or you're on a different commit. NOT refreshing Retell.`);
  }
  ok(`live build == HEAD (${expectedSha.slice(0, 12)}) — safe to refresh`);
  return { gitSha, promptSha, promptChars };
}

async function step4_refreshAndVerify(expected) {
  console.log(`\n[4/4] Pushing prompt to Retell and cross-checking the echo…`);
  const token = readToken();
  const r = await httpJson('POST', '/api/voice/refresh-prompt-with-token', {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  if (!r.ok || !r.json?.success) {
    die(`refresh failed (status ${r.status}): ${r.text.slice(0, 300)}`);
  }
  const { llmId, gitSha, promptSha, promptChars, lastModified } = r.json;
  console.log(`  refresh: llmId=${llmId} gitSha=${gitSha} promptSha=${promptSha} promptChars=${promptChars} lastModified=${lastModified}`);

  // Cross-check: the build + prompt the refresh endpoint saw must match what
  // /api/health reported a moment ago (same container, same prompt string).
  if (gitSha !== expected.gitSha || promptSha !== expected.promptSha) {
    die(`refresh echo disagrees with /api/health ` +
      `(refresh gitSha=${gitSha} promptSha=${promptSha} vs health gitSha=${expected.gitSha} promptSha=${expected.promptSha}). ` +
      `A deploy may have raced in mid-release — re-verify manually.`);
  }
  ok(`Retell LLM ${llmId} refreshed and verified — pushed the right prompt from the right build`);
  console.log('\n  New calls use the updated prompt; in-flight calls keep the old.');
}

(async () => {
  const head = gitHead();
  console.log(`Release target: ${BASE_URL}`);
  console.log(`Local HEAD:     ${head}`);
  await step2_pollUntilLive();
  const expected = await step3_assertBuild(head);
  await step4_refreshAndVerify(expected);
  console.log('\n✓ Release complete.');
})().catch((e) => {
  if (e instanceof ReleaseAbort) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = e.code;
  } else {
    console.error(`\n✗ unexpected error: ${e.stack || e.message || e}`);
    process.exitCode = 1;
  }
  // Let the event loop drain naturally — no process.exit(), so no libuv crash.
});
