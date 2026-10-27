/**
 * Prospects' replies, read automatically.
 *
 * Outreach goes out with a signed reply address (reply-routing.js). Resend
 * receives the reply and posts email.received to /api/tracking/webhook
 * (Svix-signed). The webhook only stores the reply and returns — reading it,
 * labelling it and forwarding it happen here, in the background, so Resend
 * never times out and retries are harmless (provider_email_id is unique).
 *
 * For each reply:
 *   0. on arrival (in the webhook itself), stop every sequence to that
 *      person — before anything that can fail. Only an away message, known
 *      by its subject, is let through;
 *   1. fetch the text from Resend (the webhook carries metadata only), and
 *      keep the reply itself, not the quoted thread below it;
 *   2. an automatic away message (by its headers) changes nothing;
 *   3. otherwise label it and act on the label (replies.js handleReply). If
 *      that fails — the AI is down, the allowance is used up — the sequence is
 *      stopped anyway: a person who replied never gets another automated
 *      follow-up. Labelling is retried, then left for a person;
 *   4. forward it, once, to the account's own inbox with Reply-To set to the
 *      prospect, so answering from the inbox reaches them directly. A forward
 *      that fails is retried; a reply whose text can never be fetched is
 *      still announced to the inbox, so the person sees that someone replied.
 * Only replies to one of our signed reply addresses are stored at all.
 */
import db from '../db/index.js';
import { leadIdFromAddress } from './reply-routing.js';
import { handleReply, stopSequences } from './replies.js';
import { resendApiKey, sendEmail } from '../utils/email.js';
import { getProfile } from './account-profile.js';
import { checkPlanLimitForUser, loadPlanUser } from '../middleware/auth.js';

const MAX_ATTEMPTS = 3;
const BODY_MAX = 10000;
const LABELS = {
  interested: 'Interested', referral: 'Referral', not_now: 'Not now', not_interested: 'Not interested',
  opt_out: 'Opt-out', out_of_office: 'Out of office', question: 'Question',
};

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(x => typeof x === 'string');
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const bareAddress = (v) => { const s = String(v || '').trim(); const m = s.match(/<([^<>\s]+@[^<>\s]+)>/); return (m ? m[1] : s).toLowerCase(); };
const htmlText = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Webhook: store a reply addressed to one of our reply addresses. Returns what happened. */
export function acceptInbound(event) {
  const data = event?.data || {};
  const id = str(data.email_id, 200);
  if (!id) return 'ignored';
  let leadId = null;
  let toAddress = null;
  for (const a of [...list(data.to), ...list(data.received_for), ...list(data.cc)]) {
    leadId = leadIdFromAddress(a);
    if (leadId) { toAddress = a; break; }
  }
  if (!leadId) return 'not_ours';
  const lead = db.prepare('SELECT id, user_id FROM leads WHERE id = ?').get(leadId);
  if (!lead) return 'not_ours';
  const { changes } = db.prepare(`
    INSERT OR IGNORE INTO replies (user_id, lead_id, source, provider_email_id, message_id, from_address, to_address, subject, status)
    VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, 'received')
  `).run(lead.user_id, lead.id, id, str(data.message_id, 500), str(data.from, 320), str(toAddress, 320), str(data.subject, 300));
  if (!changes) return 'duplicate';
  // Whoever replied gets no further automated follow-up, whatever happens
  // next (a fetch or the AI may fail). An away message keeps the sequence.
  if (!isAutoReply({}, data.subject)) {
    const stopped = stopSequences(lead.user_id, lead.id);
    db.prepare('UPDATE replies SET stopped_count = ? WHERE provider_email_id = ?').run(stopped, id);
  }
  return 'queued';
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// The reply itself: stop at the quoted thread ("On … wrote:", "-----Original
// Message-----", an Outlook header block, or quoted lines).
export function stripQuoted(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(on\s.{3,200}\swrote:|pada\s.{3,200}\smenulis:)\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line)) break;
    if (/^\s*_{8,}\s*$/.test(line)) break;
    if (/^\s*from:\s.+@/i.test(line) && out.some(l => l.trim())) break;
    if (/^\s*>/.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function isAutoReply(headers = {}, subject = '') {
  const h = (k) => String(headers[k] || '').toLowerCase();
  if (h('auto-submitted') && h('auto-submitted') !== 'no') return true;
  if (h('x-autoreply') || h('x-autorespond') || h('x-autoresponder')) return true;
  if (/^(auto_reply|bulk|junk)/.test(h('precedence'))) return true;
  return /^\s*(automatic reply|auto(matic)?[- ]?reply|auto:|out of (the )?office|i am out of the office|di luar pejabat)/i.test(String(subject || ''));
}

async function fetchContent(emailId) {
  const key = resendApiKey();
  if (!key) throw new Error('The Resend API key is not configured');
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Resend could not return the reply (${r.status})`);
  const e = await r.json();
  const raw = typeof e.text === 'string' && e.text.trim() ? e.text : htmlToText(e.html);
  const headers = {};
  if (e.headers && typeof e.headers === 'object') for (const [k, v] of Object.entries(e.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return { body: stripQuoted(raw).slice(0, BODY_MAX) || '(empty reply)', headers, from: str(e.from, 320), subject: str(e.subject, 300), messageId: str(e.message_id, 500) };
}

async function forwardToInbox(row, lead, body, result) {
  const profile = getProfile(row.user_id);
  const to = profile.reply_to_email || db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id)?.email;
  if (!to) return;
  const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value || 'https://sa.eiaawsolutions.com';
  const label = result ? `${LABELS[result.intent] || result.intent} (${Math.round((result.confidence || 0) * 100)}% sure)` : 'not labelled yet';
  const prospect = bareAddress(row.from_address) || lead.email;
  await sendEmail({
    to,
    subject: `${lead.name}${lead.company ? ` (${lead.company})` : ''} replied: ${row.subject || 'your email'}`.slice(0, 200),
    fromName: `${lead.name} via SalesAgent`,
    replyTo: prospect,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a">
        <p style="font-size:14px;color:#555;margin:0 0 12px"><strong>${htmlText(lead.name)}</strong> replied to your outreach. The agent labelled it <strong>${htmlText(label)}</strong>${result?.suggested_reply ? ' and drafted an answer for you to approve' : ''}. Hit reply to answer them directly, or open it in SalesAgent:
          <a href="${htmlText(baseUrl)}/app?p=replies">Replies</a>.</p>
        <div style="border-left:3px solid #1FA896;padding:4px 0 4px 12px;font-size:15px;line-height:1.6;white-space:pre-wrap">${htmlText(body)}</div>
        <p style="font-size:12px;color:#888;margin-top:16px">From ${htmlText(row.from_address || prospect)}${row.subject ? ` · Subject: ${htmlText(row.subject)}` : ''}</p>
      </div>`,
  });
  db.prepare('UPDATE replies SET forwarded_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
}

async function processOne(row) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(row.lead_id, row.user_id);
  if (!lead) {
    db.prepare("UPDATE replies SET status = 'unmatched', body = NULL WHERE id = ?").run(row.id);
    return;
  }

  let body = row.body;
  let headers = {};
  if (!body) {
    const c = await fetchContent(row.provider_email_id);
    body = c.body;
    headers = c.headers;
    db.prepare(`UPDATE replies SET body = ?, from_address = COALESCE(?, from_address), subject = COALESCE(?, subject),
                message_id = COALESCE(?, message_id) WHERE id = ?`).run(body, c.from, c.subject, c.messageId, row.id);
    row = { ...row, from_address: c.from || row.from_address, subject: c.subject || row.subject };
  }

  if (isAutoReply(headers, row.subject)) {
    db.prepare(`UPDATE replies SET intent = 'out_of_office', confidence = 1, summary = 'Automatic reply',
                actions = ?, status = 'dismissed', handled_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(JSON.stringify([row.stopped_count > 0
        ? 'Automatic reply. The sequence was stopped when it arrived — restart it from the campaign if it should carry on'
        : 'Auto-reply: the sequence carries on']), row.id);
    db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'email', 'Automatic reply received — the sequence carries on')").run(row.user_id, lead.id);
    return;
  }

  let result = null;
  let failure = null;
  try {
    checkPlanLimitForUser(loadPlanUser(row.user_id), 'ai_action');
    result = await handleReply({ userId: row.user_id, lead, text: body, replyId: row.id, stopped: row.stopped_count || 0 });
  } catch (e) {
    failure = e;
    const n = (row.stopped_count || 0) + stopSequences(row.user_id, lead.id);
    db.prepare('UPDATE replies SET actions = ? WHERE id = ?').run(JSON.stringify([
      n > 0 ? `Stopped the sequence for ${lead.name} (${n} message${n === 1 ? '' : 's'} cancelled)` : `Nothing more was scheduled to ${lead.name}`,
      `Could not label it yet: ${e.message}`,
    ]), row.id);
  }

  if (!row.forwarded_at) {
    try { await forwardToInbox(row, lead, body, result); } catch (e) { console.error('[replies] forward failed:', e.message); }
  }
  if (failure) throw failure;
}

// A reply whose text never came back from Resend: tell the inbox someone
// replied, so a person can look (the original is kept by Resend).
async function announceUnread(id) {
  const row = db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
  if (!row || row.forwarded_at || row.body) return;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(row.lead_id, row.user_id);
  if (!lead) return;
  await forwardToInbox(row, lead, '(The text of this reply could not be read from the mail provider. Open it in SalesAgent or ask EIAAW to retrieve it.)', null);
}

// Forwards that failed after a reply was read are retried for a day, without
// reading or labelling the reply again. Away messages are never forwarded.
async function retryForwards() {
  const rows = db.prepare(`
    SELECT * FROM replies WHERE source = 'inbound' AND forwarded_at IS NULL AND body IS NOT NULL
       AND status IN ('new', 'answered', 'dismissed') AND COALESCE(intent, '') <> 'out_of_office'
       AND received_at >= datetime('now', '-1 day') AND handled_at <= datetime('now', '-10 minutes')
     ORDER BY id LIMIT 10
  `).all();
  for (const row of rows) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(row.lead_id, row.user_id);
    if (!lead) continue;
    const result = row.intent ? { intent: row.intent, confidence: row.confidence, suggested_reply: row.suggested_body ? { body: row.suggested_body } : null } : null;
    try { await forwardToInbox(row, lead, row.body, result); } catch (e) {
      db.prepare('UPDATE replies SET handled_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      console.error(`[replies] forward of reply ${row.id} failed again: ${e.message}`);
    }
  }
}

let running = false;

/** Read every reply waiting to be read (and retry failed ones). */
export async function processInboundReplies({ limit = 20 } = {}) {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    db.prepare(`UPDATE replies SET status = 'failed', error = 'interrupted'
                 WHERE status = 'processing' AND handled_at <= datetime('now', '-15 minutes')`).run();
    for (;;) {
      // A failed reply waits 10 minutes between attempts.
      const rows = db.prepare(`SELECT * FROM replies WHERE source = 'inbound'
                                 AND (status = 'received' OR (status = 'failed' AND attempts < ? AND handled_at <= datetime('now', '-10 minutes')))
                               ORDER BY id LIMIT ?`).all(MAX_ATTEMPTS, limit);
      if (!rows.length) break;
      let progressed = 0;
      for (const row of rows) {
        const claimed = db.prepare(`UPDATE replies SET status = 'processing', attempts = attempts + 1, handled_at = CURRENT_TIMESTAMP
                                     WHERE id = ? AND status IN ('received', 'failed')`).run(row.id).changes;
        if (!claimed) continue;
        progressed++;
        try {
          await processOne(row);
          done++;
        } catch (e) {
          const final = row.attempts + 1 >= MAX_ATTEMPTS;
          db.prepare('UPDATE replies SET status = ?, error = ? WHERE id = ?').run(final ? 'new' : 'failed', String(e.message || e).slice(0, 300), row.id);
          console.error(`[replies] reply ${row.id} ${final ? 'left for a person' : 'will be retried'}: ${e.message}`);
          if (final) await announceUnread(row.id).catch(err => console.error('[replies] notice failed:', err.message));
        }
      }
      if (!progressed) break;
    }
    await retryForwards();
  } finally {
    running = false;
  }
  return done;
}

/** Fire-and-forget, right after the webhook stores a reply. */
export function kickInbound() {
  setImmediate(() => { processInboundReplies().catch(e => console.error('[replies] processing failed:', e.message)); });
}
