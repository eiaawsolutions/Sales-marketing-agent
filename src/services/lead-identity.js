// Identity resolution: given an inbound candidate, decide whether it is a
// person we already have.
//
// Bias: FALSE-MERGE AVERSION. Merging two humans into one lead is unrecoverable
// once outreach fires against the wrong person. Failing to merge produces two
// rows a user can join with one click. So a merge requires an identifier that
// is unique to a person by construction (email, LinkedIn profile), or a weaker
// identifier plus corroboration (phone AND the same name).
//
// A shared office line, a shared info@ inbox, or two people at the same company
// must never collapse into one lead. Every rule below is written against that.
//
// ALL lookups are scoped by user_id. Cross-tenant resolution is not a feature.

import {
  normalizeEmail, normalizePhone, normalizeLinkedIn, normalizeWebsite,
  normalizeName, isPersonLinkedIn, clampText,
} from '../utils/normalize.js';

export const MATCH = {
  EMAIL: 'email',
  LINKEDIN: 'linkedin',
  PHONE_AND_NAME: 'phone+name',
  NONE: 'none',
};

// Turn any adapter output into the canonical candidate shape. Total: never
// throws, always returns an object, every field either a bounded string or null.
export function toCandidate(raw = {}) {
  const email = normalizeEmail(raw.email);
  const phone = normalizePhone(raw.phone);
  const linkedin = normalizeLinkedIn(raw.linkedin_url);
  return {
    name: clampText(raw.name, 160),
    email: email ? clampText(raw.email, 254) : null,
    phone: phone ? clampText(raw.phone, 40) : null,
    company: clampText(raw.company, 160),
    title: clampText(raw.title, 160),
    linkedin_url: linkedin ? clampText(raw.linkedin_url, 300) : null,
    company_website: clampText(raw.company_website, 300),
    message: clampText(raw.message, 2000),

    email_normalized: email,
    phone_normalized: phone,
    // Only a /in/ profile identifies a PERSON. A /company/ URL identifies an
    // org and would merge every employee of that company into one lead.
    linkedin_normalized: isPersonLinkedIn(linkedin) ? linkedin : null,
    website_normalized: normalizeWebsite(raw.company_website),
    name_normalized: normalizeName(raw.name),
  };
}

// ---------------------------------------------------------------------------
// resolveIdentity(db, userId, candidate)
//   → { leadId, matchedOn }            an existing lead, safe to merge into
//   → { leadId: null, matchedOn: 'none', possibleDuplicateIds: [...] }
//
// Ordered strongest-first; the first hit wins. Ties inside a tier are broken by
// lowest id, i.e. the oldest record, so repeated ingestion is deterministic.
// ---------------------------------------------------------------------------
export function resolveIdentity(db, userId, candidate) {
  // Tier 1 — email. Unique per tenant by index, so at most one row.
  if (candidate.email_normalized) {
    const hit = db.prepare(
      'SELECT id FROM leads WHERE user_id = ? AND email_normalized = ?'
    ).get(userId, candidate.email_normalized);
    if (hit) return { leadId: hit.id, matchedOn: MATCH.EMAIL, possibleDuplicateIds: [] };
  }

  // Tier 2 — LinkedIn person profile. Unique per tenant by index.
  if (candidate.linkedin_normalized) {
    const hit = db.prepare(
      'SELECT id FROM leads WHERE user_id = ? AND linkedin_normalized = ?'
    ).get(userId, candidate.linkedin_normalized);
    if (hit) return { leadId: hit.id, matchedOn: MATCH.LINKEDIN, possibleDuplicateIds: [] };
  }

  // Tier 3 — phone AND matching name. Phone alone is not identifying (switchboards,
  // shared mobiles, a receptionist filling in forms), so it needs corroboration.
  if (candidate.phone_normalized && candidate.name_normalized) {
    const rows = db.prepare(
      'SELECT id, name FROM leads WHERE user_id = ? AND phone_normalized = ? ORDER BY id'
    ).all(userId, candidate.phone_normalized);
    const named = rows.filter(r => normalizeName(r.name) === candidate.name_normalized);
    if (named.length === 1) {
      return { leadId: named[0].id, matchedOn: MATCH.PHONE_AND_NAME, possibleDuplicateIds: [] };
    }
    // Two existing rows with the same phone AND the same name means the data is
    // already ambiguous. Do not guess which one to merge into.
    if (named.length > 1) {
      return { leadId: null, matchedOn: MATCH.NONE, possibleDuplicateIds: named.map(r => r.id) };
    }
  }

  // No merge. Surface weak signals so the inbox can show "looks like #42" without
  // acting on it: same phone (different name), or same name at the same company.
  const possible = new Set();
  if (candidate.phone_normalized) {
    for (const r of db.prepare(
      'SELECT id FROM leads WHERE user_id = ? AND phone_normalized = ? ORDER BY id LIMIT 5'
    ).all(userId, candidate.phone_normalized)) possible.add(r.id);
  }
  if (candidate.name_normalized && candidate.company) {
    for (const r of db.prepare(
      'SELECT id, name FROM leads WHERE user_id = ? AND LOWER(company) = LOWER(?) ORDER BY id LIMIT 20'
    ).all(userId, candidate.company)) {
      if (normalizeName(r.name) === candidate.name_normalized) possible.add(r.id);
    }
  }
  return { leadId: null, matchedOn: MATCH.NONE, possibleDuplicateIds: [...possible].slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Merge semantics.
//
//   1. Never overwrite a non-empty existing value with an empty incoming one.
//   2. Never overwrite a non-empty existing value with a DIFFERENT non-empty one.
//      The CRM record is curated; a webhook is not allowed to rename your
//      contact or move them to another company. Conflicts are recorded in notes.
//   3. Empty existing fields are filled from the candidate. This is the whole
//      point: a phone-only WhatsApp lead later supplies an email.
//   4. status never moves backwards along the funnel.
//   5. verification_sources is a union.
//   6. first_source_id is immutable; last_source_id always advances.
// ---------------------------------------------------------------------------

const FILLABLE = ['name', 'email', 'phone', 'company', 'title', 'linkedin_url', 'company_website'];
const KEY_MIRROR = {
  email: 'email_normalized',
  phone: 'phone_normalized',
  linkedin_url: 'linkedin_normalized',
};

const STATUS_RANK = {
  new: 0, contacted: 1, qualified: 2, proposal: 3, negotiation: 4, won: 5, lost: 5,
};

export function statusIsForward(from, to) {
  const a = STATUS_RANK[from];
  const b = STATUS_RANK[to];
  if (a === undefined || b === undefined) return false;
  return b > a;
}

// Pure. Returns { changes, conflicts } — `changes` is a column→value map to
// UPDATE, `conflicts` is a human-readable list for the notes trail.
export function planMerge(existing, candidate) {
  const changes = {};
  const conflicts = [];

  for (const field of FILLABLE) {
    const cur = existing[field];
    const next = candidate[field];
    if (next === null || next === undefined || next === '') continue;

    const curEmpty = cur === null || cur === undefined || cur === '';
    if (curEmpty) {
      changes[field] = next;
      const mirror = KEY_MIRROR[field];
      if (mirror && candidate[mirror]) changes[mirror] = candidate[mirror];
      continue;
    }
    if (String(cur).trim().toLowerCase() !== String(next).trim().toLowerCase()) {
      conflicts.push(`${field}: kept "${cur}", incoming "${next}"`);
    }
  }
  return { changes, conflicts };
}

// The dated provenance line appended to leads.notes on every re-touch. Matches
// the convention already used by the chatbot intake path in routes/forms.js.
export function buildTouchNote(sourceName, channel, conflicts, message) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const parts = [`[${stamp}] Touch via ${sourceName} (${channel})`];
  if (message) parts.push(`  Message: ${String(message).slice(0, 500)}`);
  if (conflicts.length) parts.push(`  Conflicting fields ignored — ${conflicts.join('; ')}`);
  return parts.join('\n');
}

// Cap notes so an attacker cannot grow one row without bound by replaying a
// webhook. Keeps the newest content, drops the oldest.
export const NOTES_MAX = 8000;
export function appendNote(existingNotes, line) {
  const joined = existingNotes ? `${existingNotes}\n${line}` : line;
  if (joined.length <= NOTES_MAX) return joined;
  return '…[older notes trimmed]\n' + joined.slice(joined.length - NOTES_MAX);
}
