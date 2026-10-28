/**
 * Long requests as background jobs.
 *
 * Cloudflare, in front of sa.eiaawsolutions.com, gives up on a request after
 * 100 seconds and returns its own HTML error page while the server carries
 * on. A lead search (web search, then reading company websites, then mailbox
 * checks) can take longer than that; the browser then showed "Unexpected
 * token '<'" (28 Oct 2026) and a second press paid for a second search. So a
 * route starts the work here, answers at once with a job id, and the page
 * asks for the result every few seconds.
 *
 * One running job of a kind per account: pressing again attaches to it. A
 * job's failure is caught and kept as its answer, never left unhandled. Kept
 * in memory on purpose: there is one app instance (SQLite on one volume), and
 * a job lost to a restart is simply run again.
 */
import crypto from 'crypto';

const KEEP_MS = 15 * 60_000; // finished jobs keep answering polls this long
const jobs = new Map();

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > KEEP_MS) jobs.delete(id);
  }
}

/** The account's running job of this kind, if there is one. */
export function runningJob(ownerId, kind) {
  for (const [id, job] of jobs) {
    if (job.ownerId === ownerId && job.kind === kind && job.status === 'running') return { id, status: 'running', alreadyRunning: true };
  }
  return null;
}

export function startJob(ownerId, kind, work) {
  sweep();
  const running = runningJob(ownerId, kind);
  if (running) return running;
  const id = crypto.randomUUID();
  const job = { ownerId, kind, status: 'running', startedAt: Date.now() };
  jobs.set(id, job);
  Promise.resolve()
    .then(work)
    .then(
      (result) => { job.status = 'done'; job.result = result; },
      (err) => {
        job.status = 'failed';
        job.error = err?.message || 'The job failed.';
        job.httpStatus = err?.status || 500;
        console.error(`[jobs] ${kind} failed: ${job.error}`);
      },
    )
    .finally(() => { job.finishedAt = Date.now(); });
  return { id, status: 'running', alreadyRunning: false };
}

/** What the page sees when it polls. Another account's job reads as missing. */
export function getJob(ownerId, id) {
  const job = jobs.get(id);
  if (!job || job.ownerId !== ownerId) return null;
  const view = { status: job.status, seconds: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000) };
  if (job.status === 'done') view.result = job.result;
  if (job.status === 'failed') { view.error = job.error; view.http_status = job.httpStatus; }
  return view;
}

export const __testing = { reset: () => jobs.clear(), sweep, size: () => jobs.size };
