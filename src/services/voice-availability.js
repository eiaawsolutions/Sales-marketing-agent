import db from '../db/index.js';
import { sendEmail } from '../utils/email.js';
import { FOUNDER_HQ_EMAIL } from '../config/hq.js';
import { getVoiceConfig, createWebCall } from './retell.js';

// One Retell account serves every EIAAW site, and Retell has no API to read
// its credit balance (docs.retellai.com/accounts/billing, Oct 2026). The only
// signs that credit is gone are a 402 "Credit balance exhausted" when a call
// is created, and a call that ends with credit_exhausted or budget_reached.
// Either one pauses voice: the sites hide "Talk to the agent", call links say
// the line is unavailable, and HQ is emailed. While paused, the line is
// checked every few minutes and voice comes back by itself once Retell
// accepts a call again.

const KEY = 'voice_availability';
const CHECK_EVERY_MS = 5 * 60 * 1000;
const CREDIT_DISCONNECTS = new Set(['credit_exhausted', 'budget_reached']);

function readState() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

function writeState(state) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(KEY, JSON.stringify(state));
}

export function voiceAvailable() {
  return !readState()?.paused;
}

// 402 is Retell's out-of-credit status; the message covers a response that lost it.
function creditReason(err) {
  const msg = String(err?.message || '');
  if (err?.status !== 402 && !/credit balance|budget (?:reached|exceeded)/i.test(msg)) return null;
  return /budget/i.test(msg) ? 'budget_reached' : 'credit_exhausted';
}

export function pauseVoice(reason) {
  const now = new Date().toISOString();
  const state = readState();
  if (state?.paused) return writeState({ ...state, checkedAt: now });
  writeState({ paused: true, reason, since: now, checkedAt: now });
  console.warn(`[voice] paused on every site: ${reason}`);
  tellHq(pausedEmail(reason, now));
}

export function resumeVoice() {
  const now = new Date().toISOString();
  const wasPaused = !!readState()?.paused;
  writeState({ paused: false, reason: null, since: now, checkedAt: now });
  if (!wasPaused) return;
  console.log('[voice] back on every site');
  tellHq(resumedEmail(now));
}

// For any error from a Retell call. True when it was about credit.
export function noteRetellError(err) {
  const reason = creditReason(err);
  if (reason) pauseVoice(reason);
  return !!reason;
}

export function noteCallEnded(disconnectionReason) {
  if (CREDIT_DISCONNECTS.has(disconnectionReason)) pauseVoice(disconnectionReason);
}

// Asks Retell for a web call nobody joins: accepted means credit is back. It
// carries no lead, so the webhook ignores it, and an unjoined call uses no minutes.
let checking = null;
export function checkVoiceLine() {
  checking ||= (async () => {
    const { provider, apiKey, agentId } = getVoiceConfig();
    if (provider !== 'retell' || !apiKey || !agentId) return;
    try {
      await createWebCall(apiKey, { agent_id: agentId, metadata: { purpose: 'availability_check' } });
      resumeVoice();
    } catch (err) {
      if (!noteRetellError(err)) console.warn(`[voice] line check failed: ${err.message}`);
    }
  })().finally(() => { checking = null; });
  return checking;
}

// At boot, checks a line that has never been checked; then, every few
// minutes, a line that is paused. A line that is on is never polled.
let timer = null;
export function startVoiceLineWatch() {
  if (timer) return;
  const tick = () => { const s = readState(); if (!s || s.paused) checkVoiceLine(); };
  tick();
  timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
}

const REASONS = {
  credit_exhausted: {
    what: 'Retell is out of credit',
    fix: 'Top up the balance on the Billing page at <a href="https://dashboard.retellai.com">dashboard.retellai.com</a>. To stop this happening again, turn on Auto recharge on the same page.',
  },
  budget_reached: {
    what: "Retell's monthly budget is used up",
    fix: 'Raise or turn off the monthly budget on the Billing page at <a href="https://dashboard.retellai.com">dashboard.retellai.com</a>, or wait for the new month.',
  },
};

const myt = (iso) => new Date(iso).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });

function pausedEmail(reason, at) {
  const why = REASONS[reason] || REASONS.credit_exhausted;
  return {
    subject: `Voice calls paused: ${why.what}`,
    html: `<p>At ${myt(at)} (Malaysia time) Retell refused a voice call: ${why.what.charAt(0).toLowerCase() + why.what.slice(1)}.</p>
<p>So that nobody sees an error, the "Talk to the agent" buttons are now hidden on sa.eiaawsolutions.com, eiaawsolutions.com and ep.eiaawsolutions.com, the chat assistant has stopped offering voice, and call links in emails say the line is unavailable.</p>
<p><b>To fix it:</b> ${why.fix}</p>
<p>The Sales Agent checks every 5 minutes and turns voice back on by itself. You will get an email when it does.</p>`,
  };
}

function resumedEmail(at) {
  return {
    subject: 'Voice calls are back on',
    html: `<p>Retell accepted a call again at ${myt(at)} (Malaysia time). The "Talk to the agent" buttons are showing on every EIAAW site, and call links work again.</p>`,
  };
}

function tellHq({ subject, html }) {
  sendEmail({ to: FOUNDER_HQ_EMAIL, subject, html })
    .catch(err => console.warn(`[voice] could not email HQ: ${err.message}`));
}
