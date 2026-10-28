import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-jobs-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.CRAWL4AI_URL;
delete process.env.REACHER_URL;

const { default: db } = await import('../src/db/index.js');
const jobs = await import('../src/services/jobs.js');
const { startBriefSearch, SearchRefused } = await import('../src/services/lead-search.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');

after(() => { agent.resetChat(); db.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  jobs.__testing.reset();
  agent.resetChat();
  for (const t of ['campaign_leads', 'activities', 'leads', 'campaigns', 'ai_cost_log', 'agent_tasks', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')").run();
});

const settle = () => new Promise(r => setImmediate(r));
function gate() { let open; const p = new Promise(r => { open = r; }); return { p, open }; }

test('a job runs in the background and its result is collected later', async () => {
  const g = gate();
  const job = jobs.startJob(2, 'search', async () => { await g.p; return { kept: 3 }; });
  assert.equal(jobs.getJob(2, job.id).status, 'running');
  g.open();
  await settle(); await settle();
  assert.deepEqual(jobs.getJob(2, job.id).result, { kept: 3 });
  assert.equal(jobs.getJob(2, job.id).status, 'done');
});

test('pressing the button again attaches to the running job instead of paying for a second', async () => {
  const g = gate();
  let runs = 0;
  const work = async () => { runs++; await g.p; return {}; };
  const first = jobs.startJob(2, 'search', work);
  const second = jobs.startJob(2, 'search', work);
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyRunning, true);
  await settle();
  assert.equal(runs, 1);
  g.open();
});

test("another account can never read a job's result", async () => {
  const job = jobs.startJob(2, 'search', async () => ({ discarded_list: [{ name: 'Someone' }] }));
  await settle(); await settle();
  assert.equal(jobs.getJob(3, job.id), null);
  assert.equal(jobs.getJob(2, 'not-a-job'), null);
});

test('a job that fails is reported with its reason and never crashes the server', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const job = jobs.startJob(2, 'search', async () => { throw Object.assign(new Error('The AI service turned down the key'), { status: 503 }); });
    await settle(); await settle(); await settle();
    const view = jobs.getJob(2, job.id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error, 'The AI service turned down the key');
    assert.equal(view.http_status, 503);
    const sync = jobs.startJob(2, 'other', () => { throw new Error('sync throw'); });
    await settle(); await settle();
    assert.equal(jobs.getJob(2, sync.id).status, 'failed');
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('finished jobs are forgotten after 15 minutes', async () => {
  const job = jobs.startJob(2, 'search', async () => ({}));
  await settle(); await settle();
  jobs.__testing.sweep(Date.now() + 16 * 60_000);
  assert.equal(jobs.getJob(2, job.id), null);
});

test('a search the brief cannot support is refused at once, not started', () => {
  assert.throws(() => startBriefSearch({ id: 2, role: 'user', plan: 'business' }), (e) => e instanceof SearchRefused && e.status === 400);
  assert.equal(jobs.__testing.size(), 0);
});

// The page's polling loop (public/app.js), run against stubbed answers. A
// failed job is answered with HTTP 200 and status "failed"; the page used to
// keep polling it for 10 minutes and then call it "still running".
function pageWaitForJob(answers) {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = src.match(/async function waitForJob\([\s\S]*?\n}\n/)[0];
  const polls = [];
  let now = 0;
  const page = {
    Date: { now: () => (now += 3000) },
    setTimeout: (f) => f(),
    api: { get: async (p) => { polls.push(p); return answers[Math.min(polls.length, answers.length) - 1]; } },
  };
  vm.createContext(page);
  vm.runInContext(fn, page);
  return { waitForJob: page.waitForJob, polls };
}

test('the page stops waiting as soon as a job fails, and says why', async () => {
  const { waitForJob, polls } = pageWaitForJob([
    { status: 'running', seconds: 3 },
    { status: 'failed', seconds: 275, error: 'Request timed out.', http_status: 500 },
  ]);
  await assert.rejects(waitForJob('/leads/find/abc'), /Request timed out/);
  assert.equal(polls.length, 2);
});

test('the page returns the result of a job that finishes', async () => {
  const { waitForJob } = pageWaitForJob([{ status: 'running', seconds: 3 }, { status: 'done', seconds: 9, result: { kept: 2 } }]);
  assert.deepEqual({ ...(await waitForJob('/leads/find/abc')) }, { kept: 2 });
});

test('a brief search runs as a job and a second press joins it', async () => {
  db.prepare("INSERT INTO account_profiles (user_id, ideal_client) VALUES (2, 'HR Directors at Malaysian manufacturers')").run();
  const g = gate();
  let calls = 0;
  agent.setChat(async () => { calls++; await g.p; return JSON.stringify({ leads: [] }); });
  const user = { id: 2, role: 'user', plan: 'business' };
  const first = startBriefSearch(user);
  const second = startBriefSearch(user);
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyRunning, true);
  g.open();
  for (let i = 0; i < 20 && jobs.getJob(2, first.id).status === 'running'; i++) await settle();
  const view = jobs.getJob(2, first.id);
  assert.equal(view.status, 'done');
  assert.equal(view.result.kept, 0);
  assert.equal(calls, 1);
});
