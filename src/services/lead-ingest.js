// The ingest core. Every lead from every channel funnels through here.
//
//   raw payload → adapter normalises → lead_inbox (staging)
//                                          │
//                     idempotency ─────────┤
//                     rule scoring ────────┤
//                     identity resolution ─┤
//                                          ▼
//                              promote?  ──┴──► leads ──► touchpoint
//                                                 │
//                                    score ≥ threshold?
//                                                 ▼
//                                        AI BANT qualification
//                                                 │
//                                            qualified?
//                                                 ▼
//                                        pipeline deal (prospecting)
//
// ── Where the Lead Generation Contract applies ─────────────────────────────
//
// The contract's verification gate ("≥1 verifiable source URL, discard on Low
// confidence") governs OUTBOUND SOURCING — us going out and asserting that a
// stranger exists and is reachable. Those paths are `apollo` and `ai_websearch`,
// and their gate already lives in ai-agent.js. It stays there, untouched.
//
// It does NOT govern INBOUND self-reported leads. When a human types their own
// name and email into your form, chatbot, or Calendly booking, they ARE the
// evidence. Demanding a LinkedIn URL before we may store a person who just
// asked you to call them would discard real revenue. What we do instead:
//   - store only what they actually typed; never guess, derive, or synthesise
//     an email or phone from a name or domain;
//   - mark them self-reported so nobody mistakes them for verified prospects;
//   - stage them so a human sees them before outreach.
// That is the same reasoning already written into the chatbot intake handler.

import db from '../db/index.js';
import crypto from 'crypto';
import { toCandidate, resolveIdentity, planMerge, buildTouchNote, appendNote, MATCH } from './lead-identity.js';
import { scoreLead, getRules, getLeadSettings } from './lead-scoring.js';
import { leadSourcesService } from './lead-sources.js';
import { checkPlanLimitForUser, loadPlanUser } from '../middleware/auth.js';
import { pipelineService } from './pipeline.js';

const RAW_PAYLOAD_MAX = 16_000;

export class IngestRejected extends Error {
  constructor(reason, status = 422) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

function dedupeKeyFor(sourceId, candidate) {
  const identity = [
    candidate.email_normalized || '',
    candidate.phone_normalized || '',
    candidate.linkedin_normalized || '',
  ].join('|');
  return crypto.createHash('sha256').update(`${sourceId}:${identity}`).digest('hex');
}

// ---------------------------------------------------------------------------
// ingest(source, payload, meta) → result
//
// `source` is the raw lead_sources row. `payload` is adapter output. Synchronous
// and fast: a webhook caller gets its response before any Claude call happens.
// ---------------------------------------------------------------------------
export function ingest(source, payload, meta = {}) {
  const userId = source.user_id;
  leadSourcesService.recordEvent(source.id, 'received');

  const candidate = toCandidate(payload);

  // A lead with no way to reach it is not a lead. Reject before it costs a row.
  if (!candidate.email_normalized && !candidate.phone_normalized && !candidate.linkedin_normalized) {
    leadSourcesService.recordEvent(source.id, 'rejected', 'no contact identifier');
    throw new IngestRejected('No email, phone, or LinkedIn profile in payload');
  }
  if (!candidate.name) {
    // A nameless lead is storable (some channels only give an email) but it is
    // penalised by the scoring rules rather than dropped.
    candidate.name = candidate.email || candidate.phone || 'Unknown';
  }

  const externalId = typeof meta.externalId === 'string' && meta.externalId
    ? meta.externalId.slice(0, 200)
    : null;
  const dedupeKey = dedupeKeyFor(source.id, candidate);

  const rules = getRules(db, userId);
  const settings = getLeadSettings(db, userId);
  const { score, breakdown } = scoreLead({ ...candidate, source_type: source.type }, rules);

  const identity = resolveIdentity(db, userId, candidate);

  // Insert the staging row. The UNIQUE(source_id, external_id) partial index is
  // what makes webhook redelivery a no-op — we let the DB decide, rather than
  // read-then-write, which would race two concurrent redeliveries.
  let inboxId;
  try {
    inboxId = db.prepare(`
      INSERT INTO lead_inbox (
        user_id, source_id, external_id, dedupe_key, raw_payload,
        name, email, phone, company, title, linkedin_url, company_website, message,
        email_normalized, phone_normalized, linkedin_normalized,
        score, score_breakdown, status, matched_lead_id, ip, user_agent
      ) VALUES (?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?, ?,?,'pending',?,?,?)
      RETURNING id
    `).get(
      userId, source.id, externalId, dedupeKey,
      JSON.stringify(meta.raw ?? payload).slice(0, RAW_PAYLOAD_MAX),
      candidate.name, candidate.email, candidate.phone, candidate.company, candidate.title,
      candidate.linkedin_url, candidate.company_website, candidate.message,
      candidate.email_normalized, candidate.phone_normalized, candidate.linkedin_normalized,
      score, JSON.stringify(breakdown), identity.leadId,
      meta.ip || null, (meta.userAgent || '').slice(0, 300) || null
    ).id;
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      leadSourcesService.recordEvent(source.id, 'duplicate');
      return { status: 'duplicate', idempotent: true, externalId };
    }
    throw e;
  }

  // ── Promotion policy ─────────────────────────────────────────────────────
  //
  // Two independent questions:
  //   (1) may this source write into `leads` without a human looking? and
  //   (2) is this person already in the CRM?
  //
  // A source whose key is embedded in public page source (`auth_mode: 'public'`)
  // may CREATE a staged lead and may record that a known person touched us
  // again — but it may never MUTATE an existing lead's fields. Otherwise anyone
  // who can read your page source could POST your customer's email with their
  // own phone number and quietly repoint your outreach. That is exactly the
  // rule the current chatbot handler already follows (it appends a note and
  // refuses to overwrite), generalised to every public source.
  const sourceIsPublic = source.auth_mode === 'public';
  const clearsThreshold = score >= settings.auto_promote_threshold;
  const shouldPromote = source.auto_promote === 1 && clearsThreshold;

  if (identity.leadId) {
    // Known person. Always record the touch — that is free, safe, and the whole
    // point of multi-touch attribution.
    const merged = touchExistingLead({
      userId, source, leadId: identity.leadId, candidate, inboxId,
      allowFieldMerge: !sourceIsPublic,
    });
    finishInbox(inboxId, 'accepted', { promotedLeadId: identity.leadId });
    leadSourcesService.recordEvent(source.id, 'accepted');
    maybeQualify(userId, identity.leadId, score, settings);
    return {
      status: 'accepted', leadId: identity.leadId, inboxId, score,
      deduped: true, matchedOn: identity.matchedOn, fieldsMerged: merged.applied,
    };
  }

  if (!shouldPromote) {
    // Stays pending. The Inbox page shows it with its score and any weak
    // duplicate hints so a human can accept, reject, or merge.
    leadSourcesService.recordEvent(source.id, 'accepted');
    return {
      status: 'pending', inboxId, score,
      possibleDuplicateIds: identity.possibleDuplicateIds,
      reason: source.auto_promote !== 1 ? 'source requires review' : `score ${score} below auto-promote threshold ${settings.auto_promote_threshold}`,
    };
  }

  const promoted = promoteInboxRow(userId, inboxId, { skipPlanCheck: false });
  if (!promoted.ok) {
    return { status: 'pending', inboxId, score, reason: promoted.reason };
  }
  leadSourcesService.recordEvent(source.id, 'accepted');
  maybeQualify(userId, promoted.leadId, score, settings);
  return { status: 'accepted', leadId: promoted.leadId, inboxId, score, deduped: false };
}

// ---------------------------------------------------------------------------
// promoteInboxRow — staging → leads. Used by auto-promotion above and by the
// manual "Accept" button on the Inbox page.
// ---------------------------------------------------------------------------
export function promoteInboxRow(userId, inboxId, { skipPlanCheck = false } = {}) {
  const row = db.prepare('SELECT * FROM lead_inbox WHERE id = ? AND user_id = ?').get(inboxId, userId);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.status === 'accepted' && row.promoted_lead_id) {
    return { ok: true, leadId: row.promoted_lead_id, alreadyPromoted: true };
  }

  const source = db.prepare('SELECT * FROM lead_sources WHERE id = ?').get(row.source_id);

  if (!skipPlanCheck) {
    try {
      checkPlanLimitForUser(loadPlanUser(userId), 'leads');
    } catch (e) {
      // Leave it pending, not rejected — it becomes promotable again on upgrade.
      db.prepare('UPDATE lead_inbox SET reject_reason = ? WHERE id = ?').run(String(e.message).slice(0, 300), inboxId);
      return { ok: false, reason: e.message };
    }
  }

  // Re-resolve identity at promotion time. Between staging and a human clicking
  // Accept, the person may have arrived through another channel.
  const candidate = toCandidate(row);
  const identity = resolveIdentity(db, userId, candidate);
  if (identity.leadId) {
    touchExistingLead({
      userId, source, leadId: identity.leadId, candidate, inboxId,
      allowFieldMerge: source.auth_mode !== 'public',
    });
    finishInbox(inboxId, 'accepted', { promotedLeadId: identity.leadId, matchedLeadId: identity.leadId });
    return { ok: true, leadId: identity.leadId, deduped: true };
  }

  const notes = buildProvenanceNotes(source, row);

  const created = db.prepare(`
    INSERT INTO leads (
      user_id, name, email, company, title, phone, source, source_id,
      first_source_id, last_source_id, score, score_breakdown, status, notes,
      email_normalized, phone_normalized, linkedin_normalized,
      linkedin_url, company_website, touch_count
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?,?,?,?,1)
    RETURNING id
  `).get(
    userId, row.name, row.email, row.company, row.title, row.phone,
    source.type, source.id, source.id, source.id,
    row.score, row.score_breakdown, notes,
    row.email_normalized, row.phone_normalized, row.linkedin_normalized,
    row.linkedin_url, row.company_website
  );

  db.prepare(`
    INSERT INTO lead_touchpoints (user_id, lead_id, source_id, inbox_id, channel, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, created.id, source.id, inboxId, source.type,
    JSON.stringify({ first_touch: true, score: row.score }));

  db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
    .run(userId, created.id, 'note', `New lead via ${source.name} (${source.type}) — rule score ${row.score}/100`);

  finishInbox(inboxId, 'accepted', { promotedLeadId: created.id });
  return { ok: true, leadId: created.id, deduped: false };
}

export function rejectInboxRow(userId, inboxId, reason = 'rejected by user') {
  const row = db.prepare('SELECT source_id FROM lead_inbox WHERE id = ? AND user_id = ?').get(inboxId, userId);
  if (!row) return false;
  db.prepare(`
    UPDATE lead_inbox SET status = 'rejected', reject_reason = ?, processed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?
  `).run(String(reason).slice(0, 300), inboxId, userId);
  leadSourcesService.recordEvent(row.source_id, 'rejected');
  return true;
}

// ---------------------------------------------------------------------------
// Existing lead: record the touch, optionally fill empty fields.
// ---------------------------------------------------------------------------
function touchExistingLead({ userId, source, leadId, candidate, inboxId, allowFieldMerge }) {
  const existing = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(leadId, userId);
  if (!existing) return { applied: [] };

  const { changes, conflicts } = allowFieldMerge
    ? planMerge(existing, candidate)
    : { changes: {}, conflicts: [] };

  const note = buildTouchNote(source.name, source.type, conflicts, candidate.message);
  const nextNotes = appendNote(existing.notes, note);

  const sets = ['last_source_id = ?', 'touch_count = touch_count + 1', 'notes = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [source.id, nextNotes];

  for (const [col, value] of Object.entries(changes)) {
    sets.push(`${col} = ?`); // `col` comes only from planMerge's closed field list
    params.push(value);
  }
  // first_source_id is immutable, but backfill it for leads created before the
  // Source layer existed. COALESCE keeps the original when one is already set.
  sets.push('first_source_id = COALESCE(first_source_id, ?)');
  params.push(source.id);

  params.push(leadId, userId);
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

  db.prepare(`
    INSERT INTO lead_touchpoints (user_id, lead_id, source_id, inbox_id, channel, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, leadId, source.id, inboxId, source.type,
    JSON.stringify({ merged: Object.keys(changes), conflicts, field_merge_allowed: allowFieldMerge }));

  db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
    .run(userId, leadId, 'note',
      `Returning contact via ${source.name} (${source.type})` +
      (Object.keys(changes).length ? ` — filled ${Object.keys(changes).join(', ')}` : '') +
      (conflicts.length ? ` — ${conflicts.length} conflicting field(s) ignored` : ''));

  return { applied: Object.keys(changes), conflicts };
}

function finishInbox(inboxId, status, { promotedLeadId = null, matchedLeadId = null } = {}) {
  db.prepare(`
    UPDATE lead_inbox
       SET status = ?, promoted_lead_id = COALESCE(?, promoted_lead_id),
           matched_lead_id = COALESCE(?, matched_lead_id),
           processed_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(status, promotedLeadId, matchedLeadId, inboxId);
}

// The provenance block folded into leads.notes. Inbound leads are labelled
// self-reported so nobody confuses them with a verified outbound prospect.
function buildProvenanceNotes(source, row) {
  const lines = [
    `Source: ${source.name} (${source.type})`,
    'Lead type: Inbound (self-reported)',
    'Confidence: Self-reported — verify before outreach',
    `Rule score: ${row.score}/100`,
  ];
  if (row.company_website) lines.push(`Website: ${row.company_website}`);
  if (row.linkedin_url) lines.push(`Profile: ${row.linkedin_url}`);
  if (row.message) lines.push(`Message: ${String(row.message).slice(0, 500)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Deferred AI qualification.
//
// A webhook caller must not wait on a Claude round-trip; Google Ads and Calendly
// both time out well before one completes. So we answer first and qualify after,
// on a serial in-process queue. Concurrency 1: this box also serves the app, and
// a burst of 200 form submissions must not open 200 Claude calls.
//
// Every failure is swallowed and written to the activity log. A qualification
// that could not run must never take down the ingest endpoint or the process.
// ---------------------------------------------------------------------------
const qualifyQueue = [];
let qualifyDraining = false;
export const MAX_QUALIFY_QUEUE = 500;

function maybeQualify(userId, leadId, score, settings) {
  if (score < settings.ai_qualify_threshold) return false;
  if (qualifyQueue.length >= MAX_QUALIFY_QUEUE) {
    console.warn(`[ingest] qualification queue full (${MAX_QUALIFY_QUEUE}); lead ${leadId} scored ${score} but was not queued`);
    return false;
  }
  qualifyQueue.push({ userId, leadId, score, settings });
  if (!qualifyDraining) {
    qualifyDraining = true;
    setImmediate(drainQualifyQueue);
  }
  return true;
}

async function drainQualifyQueue() {
  while (qualifyQueue.length) {
    const job = qualifyQueue.shift();
    try {
      await qualifyAndMaybeOpenDeal(job);
    } catch (e) {
      console.error(`[ingest] qualification failed for lead ${job.leadId}:`, e.message);
      try {
        db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
          .run(job.userId, job.leadId, 'note', `AI qualification skipped: ${String(e.message).slice(0, 200)}`);
      } catch { /* the lead may have been deleted mid-flight */ }
    }
  }
  qualifyDraining = false;
}

async function qualifyAndMaybeOpenDeal({ userId, leadId, settings }) {
  // Plan cap first: an AI call the tenant has not paid for must not be made.
  checkPlanLimitForUser(loadPlanUser(userId), 'ai_action');

  // Imported lazily so this module never participates in an import cycle with
  // ai-agent.js, and so a Claude misconfiguration cannot break ingest at boot.
  const { runAgent } = await import('./ai-agent.js');
  const result = await runAgent(userId, 'qualify_lead', { leadId });

  if (!result?.qualified) return;

  db.prepare("UPDATE leads SET qualified_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(leadId, userId);

  if (!settings.auto_create_deal) return;
  const already = db.prepare('SELECT id FROM pipeline WHERE lead_id = ?').get(leadId);
  if (already) return;

  pipelineService.create(userId, {
    lead_id: leadId,
    stage: 'prospecting',
    deal_value: settings.default_deal_value || 0,
    probability: 10,
    notes: 'Opened automatically when AI qualification passed.',
  });
  db.prepare('INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, ?, ?)')
    .run(userId, leadId, 'ai_action', 'Auto-created pipeline deal at Prospecting after AI qualification');
}

// Test seam: drain synchronously instead of waiting on setImmediate.
export const __testing = { dedupeKeyFor, buildProvenanceNotes, qualifyQueue };
