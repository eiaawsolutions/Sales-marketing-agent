// Deterministic lead scoring. Runs on EVERY lead, costs nothing, no AI call.
//
// The AI qualification pass is expensive (one Claude call, one ai_action against
// the tenant's plan cap) so it must not run on every inbound webhook. This
// engine is the cheap filter in front of it: score first, spend later, and only
// on leads that clear the tenant's threshold.
//
// Rules are data, stored per-tenant in lead_scoring_rules. Fields and operators
// come from a closed allowlist — a rule is never interpolated into SQL, never
// compiled to a regex (ReDoS on attacker-controlled form fields), and never
// eval'd.

import { emailDomain, isFreemailDomain } from '../utils/normalize.js';

// field → how to read it off a candidate/lead object.
// Keeping this a closed map is what makes an arbitrary `field` string safe.
export const SCORE_FIELDS = {
  source_type: (l) => l.source_type ?? null,
  title: (l) => l.title ?? null,
  company: (l) => l.company ?? null,
  name: (l) => l.name ?? null,
  message: (l) => l.message ?? null,
  email: (l) => l.email ?? null,
  email_domain: (l) => emailDomain(l.email_normalized ?? null),
  phone: (l) => l.phone ?? null,
  linkedin_url: (l) => l.linkedin_url ?? null,
  company_website: (l) => l.company_website ?? null,
  lead_type: (l) => l.lead_type ?? null,
  confidence_score: (l) => l.confidence_score ?? null,
  is_freemail: (l) => isFreemailDomain(emailDomain(l.email_normalized ?? null)),
};

const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

// Split a rule's stored `value` into a list. Rules are authored in a UI, so the
// separator is a comma; whitespace around entries is noise.
function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
}

const lower = (v) => (v === null || v === undefined ? '' : String(v).toLowerCase());

export const SCORE_OPS = {
  is_present: (actual) => !isBlank(actual) && actual !== false,
  is_absent: (actual) => isBlank(actual) || actual === false,
  equals: (actual, value) => lower(actual) === lower(value),
  not_equals: (actual, value) => lower(actual) !== lower(value),
  contains: (actual, value) => !isBlank(actual) && lower(actual).includes(lower(value)),
  not_contains: (actual, value) => isBlank(actual) || !lower(actual).includes(lower(value)),
  starts_with: (actual, value) => !isBlank(actual) && lower(actual).startsWith(lower(value)),
  // "any of" — the workhorse for seniority keywords and channel groups.
  in: (actual, value) => asList(value).includes(lower(actual)),
  not_in: (actual, value) => !asList(value).includes(lower(actual)),
  contains_any: (actual, value) => {
    if (isBlank(actual)) return false;
    const hay = lower(actual);
    return asList(value).some((needle) => hay.includes(needle));
  },
  gte: (actual, value) => Number(actual) >= Number(value),
  lte: (actual, value) => Number(actual) <= Number(value),
  is_true: (actual) => actual === true,
  is_false: (actual) => actual === false,
};

export function isValidRule(rule) {
  return !!(rule
    && typeof rule.field === 'string' && Object.hasOwn(SCORE_FIELDS, rule.field)
    && typeof rule.op === 'string' && Object.hasOwn(SCORE_OPS, rule.op)
    && Number.isInteger(rule.points));
}

// ---------------------------------------------------------------------------
// scoreLead(subject, rules) → { score, breakdown }
//
// Pure. `subject` is a candidate (pre-promotion) or a lead row, plus source_type.
// Score is clamped to 0-100 to match the existing leads.score contract and the
// AI scorer's range.
// ---------------------------------------------------------------------------
export function scoreLead(subject, rules) {
  const breakdown = [];
  let total = 0;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!isValidRule(rule)) {
      breakdown.push({ rule: rule?.name ?? '(unnamed)', points: 0, matched: false, error: 'invalid rule — skipped' });
      continue;
    }
    const actual = SCORE_FIELDS[rule.field](subject);
    let matched = false;
    try {
      matched = SCORE_OPS[rule.op](actual, rule.value);
    } catch {
      matched = false; // A rule must never be able to throw the ingest path.
    }
    if (matched) {
      total += rule.points;
      breakdown.push({ rule: rule.name, field: rule.field, op: rule.op, points: rule.points, matched: true });
    }
  }

  const score = Math.max(0, Math.min(100, total));
  return { score, breakdown, rawTotal: total };
}

// ---------------------------------------------------------------------------
// Default rule set, seeded per tenant on first use.
//
// Weights encode one claim: intent beats identity. Someone who booked a meeting
// is worth more than a senior title scraped off a directory. Every rule is
// visible and editable in the UI, so these are a starting point, not a verdict.
// ---------------------------------------------------------------------------
export const DEFAULT_RULES = [
  { name: 'Booked a meeting', field: 'source_type', op: 'equals', value: 'calendly', points: 35 },
  { name: 'Submitted an ad lead form', field: 'source_type', op: 'equals', value: 'google_ads', points: 25 },
  { name: 'Inbound web form or chatbot', field: 'source_type', op: 'in', value: 'web_form,chatbot', points: 20 },
  { name: 'Replied by email', field: 'source_type', op: 'equals', value: 'email_inbound', points: 20 },
  { name: 'Left a message', field: 'message', op: 'is_present', value: null, points: 10 },
  { name: 'Gave a phone number', field: 'phone', op: 'is_present', value: null, points: 20 },
  { name: 'Has a LinkedIn profile', field: 'linkedin_url', op: 'is_present', value: null, points: 15 },
  { name: 'Has a company website', field: 'company_website', op: 'is_present', value: null, points: 10 },
  {
    name: 'Decision-maker title', field: 'title', op: 'contains_any',
    value: 'founder,co-founder,ceo,cto,cmo,coo,owner,partner,president,director,head of,vp,vice president,chief,managing',
    points: 20,
  },
  { name: 'Verified high confidence', field: 'confidence_score', op: 'equals', value: 'High', points: 10 },
  { name: 'Marked hot by sourcing', field: 'lead_type', op: 'equals', value: 'Hot', points: 15 },
  // Negative signals. Freemail is a weak B2B signal but a normal B2C one, so
  // this is deliberately small and easy to switch off.
  { name: 'Personal email domain', field: 'is_freemail', op: 'is_true', value: null, points: -10 },
  { name: 'No name provided', field: 'name', op: 'is_absent', value: null, points: -20 },
];

export function ensureDefaultRules(db, userId) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM lead_scoring_rules WHERE user_id = ?').get(userId);
  if (existing.c > 0) return false;
  const insert = db.prepare(`
    INSERT INTO lead_scoring_rules (user_id, name, field, op, value, points, enabled, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const run = db.transaction(() => {
    DEFAULT_RULES.forEach((r, i) => insert.run(userId, r.name, r.field, r.op, r.value, r.points, i));
  });
  run();
  return true;
}

export function getRules(db, userId) {
  ensureDefaultRules(db, userId);
  return db.prepare(
    'SELECT * FROM lead_scoring_rules WHERE user_id = ? ORDER BY sort_order, id'
  ).all(userId);
}

export const DEFAULT_SETTINGS = {
  ai_qualify_threshold: 60,
  auto_promote_threshold: 40,
  auto_create_deal: 1,
  default_deal_value: 0,
};

export function getLeadSettings(db, userId) {
  const row = db.prepare('SELECT * FROM lead_settings WHERE user_id = ?').get(userId);
  if (row) return row;
  db.prepare(`
    INSERT OR IGNORE INTO lead_settings (user_id, ai_qualify_threshold, auto_promote_threshold, auto_create_deal, default_deal_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, DEFAULT_SETTINGS.ai_qualify_threshold, DEFAULT_SETTINGS.auto_promote_threshold,
    DEFAULT_SETTINGS.auto_create_deal, DEFAULT_SETTINGS.default_deal_value);
  return db.prepare('SELECT * FROM lead_settings WHERE user_id = ?').get(userId)
    || { user_id: userId, ...DEFAULT_SETTINGS };
}
