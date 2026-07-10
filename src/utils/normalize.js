// Normalization primitives for identity resolution.
//
// Every value stored in a `*_normalized` column comes from exactly one of these
// functions. They are pure and total: any input returns either a canonical
// string or null. Never throw — ingest runs on attacker-controlled payloads.
//
// The guiding rule is FALSE-MERGE AVERSION. Merging two different humans into
// one lead is unrecoverable (you cannot un-ring that bell once outreach fires);
// failing to merge one human into two rows is an annoyance a user can fix with
// a click. So every normalizer here is deliberately conservative — it collapses
// only differences that are certainly cosmetic.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s || s.length > 254) return null;
  if (!EMAIL_RE.test(s)) return null;
  // Deliberately NOT stripping gmail dots or +tags. `a.b@gmail.com` and
  // `ab@gmail.com` are the same Gmail inbox, but the same transformation
  // applied to a corporate domain would merge two distinct employees.
  // Exact-match-after-lowercase is the only universally safe rule.
  return s;
}

// Digits only. A leading '+' is dropped, so "+60 12-345 6789" → "60123456789".
//
// Known limitation, accepted on purpose: "+60123456789" and "0123456789" are
// the same Malaysian number but normalize differently, so they will NOT match.
// Fixing that requires knowing the tenant's default country and applying
// libphonenumber-grade parsing; guessing it would merge a Malaysian 01x number
// with an Italian 01x number. Two rows beats a wrong merge.
export function normalizePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

// Canonical form: "linkedin.com/in/<slug>". Company pages ("/company/<slug>")
// are kept too, but they identify an ORG, not a person — callers must not use a
// /company/ URL as a person-identity key.
export function normalizeLinkedIn(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^[a-z0-9-]+\.linkedin\.com/, 'linkedin.com');
  if (!s.startsWith('linkedin.com/')) return null;
  s = s.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const m = s.match(/^linkedin\.com\/(in|company)\/([a-z0-9\-_%.]+)$/);
  if (!m) return null;
  return `linkedin.com/${m[1]}/${m[2]}`;
}

export function isPersonLinkedIn(normalized) {
  return typeof normalized === 'string' && normalized.startsWith('linkedin.com/in/');
}

// Canonical registrable form of a website: lowercase host, no scheme, no www,
// no path. Used to compare company websites and to derive an email domain.
export function normalizeWebsite(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  return s;
}

export function emailDomain(normalizedEmail) {
  if (typeof normalizedEmail !== 'string') return null;
  const at = normalizedEmail.lastIndexOf('@');
  return at === -1 ? null : normalizedEmail.slice(at + 1);
}

// Strip diacritics, collapse case, punctuation, and whitespace runs, so
// "Amós  TAN" and "amos tan" compare equal. Honorifics are NOT stripped:
// "Dr. Amos Tan" → "dr amos tan", which will not equal "amos tan".
// Used only as a CORROBORATING signal alongside a phone match — never as a
// match key on its own, because names are not unique.
export function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const s = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
  'qq.com', '163.com', '126.com',
]);

export function isFreemailDomain(domain) {
  return typeof domain === 'string' && FREEMAIL.has(domain);
}

// Bound every free-text field before it reaches the DB or a prompt.
export function clampText(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
