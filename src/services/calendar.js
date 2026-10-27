/**
 * Real meeting times from the account's own booking calendar.
 *
 * The Brief holds one booking link: a Cal.com event (public — no key needed
 * to read free times or to book) or a Calendly event (needs the account's
 * personal access token, stored encrypted; booking through Calendly's API
 * needs a paid Calendly plan). Times the agent has already booked in this app
 * are taken out as well, in case a booking never reached the calendar.
 *
 * Every call fails safe: if the calendar cannot be read, no times are
 * offered and the assistant asks the prospect what suits them instead. A
 * time is never offered that the calendar did not say is free.
 */
import db from '../db/index.js';
import { getProfile } from './account-profile.js';
import { decrypt } from '../utils/crypto.js';

export const TIME_ZONE = 'Asia/Kuala_Lumpur';
const CALCOM = 'https://api.cal.com';
const CALENDLY = 'https://api.calendly.com';
const TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60 * 1000;
const LOOKAHEAD_DAYS = 7;
const MIN_NOTICE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SLOT_MINUTES = 30;
// Business hours the offered times fall in, Malaysia time.
const DAY_START_MIN = 9 * 60;
const DAY_END_MIN = 17 * 60 + 30;
// Preferred times of day, in turn, so offers are spread (3 pm, 10 am, …).
const PREFERRED_MIN = [15 * 60, 10 * 60, 14 * 60 + 30, 11 * 60];

/** Which calendar a booking link belongs to, or null. https only. */
export function parseBookingLink(link) {
  let u;
  try { u = new URL(String(link || '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (host === 'calendly.com' || host === 'www.calendly.com') {
    return parts.length >= 2 ? { provider: 'calendly', link: `https://calendly.com/${parts[0]}/${parts[1]}`, username: parts[0], slug: parts[1] } : null;
  }
  if (host === 'cal.com' || host === 'www.cal.com' || host === 'app.cal.com') {
    if (parts[0] === 'team' && parts.length >= 3) return { provider: 'calcom', teamSlug: parts[1], slug: parts[2] };
    return parts.length >= 2 ? { provider: 'calcom', username: parts[0], slug: parts[1] } : null;
  }
  const org = host.match(/^([a-z0-9-]+)\.cal\.com$/);
  if (org && parts.length >= 2) return { provider: 'calcom', organizationSlug: org[1], username: parts[0], slug: parts[1] };
  return null;
}

// ── Formatting, Malaysia time ─────────────────────────────────────────────
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const dateKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const minutesFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function slotLabel(iso) {
  const d = new Date(iso);
  return `${dayFmt.format(d)} at ${timeFmt.format(d).toLowerCase().replace(/\s/g, ' ')}`;
}
function dateKey(d) { return dateKeyFmt.format(d); }
function minuteOfDay(d) { const [h, m] = minutesFmt.format(d).split(':').map(Number); return h * 60 + m; }

// ── Provider reads ────────────────────────────────────────────────────────
async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} ${r.status}`);
  return r.json();
}

async function calcomSlots(cal, from, to) {
  const q = new URLSearchParams({ start: from.toISOString(), end: to.toISOString(), timeZone: TIME_ZONE, eventTypeSlug: cal.slug });
  if (cal.username) q.set('username', cal.username);
  if (cal.teamSlug) q.set('teamSlug', cal.teamSlug);
  if (cal.organizationSlug) q.set('organizationSlug', cal.organizationSlug);
  const body = await getJson(`${CALCOM}/v2/slots?${q}`, { 'cal-api-version': '2024-09-04' });
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  return Object.values(data).flat().map(s => s?.start).filter(Boolean);
}

function calendlyToken(userId) {
  const raw = db.prepare('SELECT calendly_token FROM account_profiles WHERE user_id = ?').get(userId)?.calendly_token;
  return raw ? decrypt(raw) : null;
}

// The Calendly event type behind the link, looked up once per link and kept.
async function calendlyEventType(userId, cal, token) {
  const key = `calendly_event_type_${userId}`;
  try {
    const cached = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || 'null');
    if (cached?.link === cal.link && cached.uri) return cached.uri;
  } catch { /* look it up again */ }
  const auth = { Authorization: `Bearer ${token}` };
  const me = await getJson(`${CALENDLY}/users/me`, auth);
  const userUri = me?.resource?.uri;
  if (!userUri) throw new Error('calendly user not found');
  const types = await getJson(`${CALENDLY}/event_types?${new URLSearchParams({ user: userUri, count: '100' })}`, auth);
  const want = cal.link.toLowerCase().replace(/\/$/, '');
  const match = (types?.collection || []).find(t => String(t.scheduling_url || '').toLowerCase().replace(/\/$/, '') === want || t.slug === cal.slug);
  if (!match?.uri) throw new Error('calendly event type not found for this link');
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(key, JSON.stringify({ link: cal.link, uri: match.uri }));
  return match.uri;
}

async function calendlySlots(userId, cal, from, to) {
  const token = calendlyToken(userId);
  if (!token) return [];
  const uri = await calendlyEventType(userId, cal, token);
  const q = new URLSearchParams({ event_type: uri, start_time: from.toISOString(), end_time: to.toISOString() });
  const body = await getJson(`${CALENDLY}/event_type_available_times?${q}`, { Authorization: `Bearer ${token}` });
  return (body?.collection || []).filter(s => !s.status || s.status === 'available').map(s => s.start_time).filter(Boolean);
}

// Meetings already booked here: never offer a time that clashes with one.
function bookedRanges(userId, from, to) {
  return db.prepare(`
    SELECT scheduled_at, COALESCE(duration_minutes, 30) AS mins FROM appointments
     WHERE user_id = ? AND status IN ('scheduled', 'confirmed') AND scheduled_at < ? AND scheduled_at > ?
  `).all(userId, to.toISOString(), new Date(from.getTime() - 4 * 3600 * 1000).toISOString())
    .map(a => { const s = new Date(a.scheduled_at).getTime(); return [s, s + a.mins * 60000]; });
}

const cache = new Map();

/**
 * Every free start time in the next week (ISO strings, sorted), from the
 * account's calendar minus what is already booked here. [] when there is no
 * calendar; null when it could not be read (unknown is not "fully booked").
 */
export async function freeTimes(userId, { now = new Date() } = {}) {
  const cal = parseBookingLink(getProfile(userId).booking_link);
  if (!cal) return [];
  const hit = cache.get(userId);
  if (hit && hit.link === JSON.stringify(cal) && now.getTime() - hit.at < CACHE_MS) return hit.times;

  const from = new Date(now.getTime() + MIN_NOTICE_MS);
  const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000);
  let starts = [];
  try {
    starts = cal.provider === 'calcom' ? await calcomSlots(cal, from, to) : await calendlySlots(userId, cal, from, to);
  } catch (e) {
    console.warn(`[calendar] could not read ${cal.provider} for account ${userId}: ${e.message}`);
    return null;
  }
  const booked = bookedRanges(userId, from, to);
  const times = [...new Set(starts.map(s => new Date(s)).filter(d => !Number.isNaN(d.getTime()) && d >= from && d <= to)
    .filter(d => { const t = d.getTime(); return !booked.some(([s, e]) => t < e && t + DEFAULT_SLOT_MINUTES * 60000 > s); })
    .map(d => d.toISOString()))].sort();
  cache.set(userId, { at: now.getTime(), link: JSON.stringify(cal), times });
  return times;
}

/**
 * A few free times to offer, on different days and spread across the day,
 * within business hours: [{ start, label }].
 */
export async function offerTimes(userId, { count = 3, now } = {}) {
  const times = ((await freeTimes(userId, { now })) || []).map(s => new Date(s))
    .filter(d => { const m = minuteOfDay(d); return m >= DAY_START_MIN && m <= DAY_END_MIN; });
  const byDay = new Map();
  for (const d of times) {
    const k = dateKey(d);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(d);
  }
  const picks = [];
  let i = 0;
  for (const day of byDay.values()) {
    if (picks.length >= count) break;
    const want = PREFERRED_MIN[i++ % PREFERRED_MIN.length];
    const best = day.reduce((a, b) => (Math.abs(minuteOfDay(b) - want) < Math.abs(minuteOfDay(a) - want) ? b : a));
    picks.push(best);
  }
  return picks.map(d => ({ start: d.toISOString(), label: slotLabel(d) }));
}

/**
 * Is this start time free on the account's calendar (and not booked here)?
 * null when the calendar could not be read.
 */
export async function isFree(userId, startIso, opts = {}) {
  const t = new Date(startIso).getTime();
  const times = await freeTimes(userId, opts);
  return times === null ? null : times.some(s => new Date(s).getTime() === t);
}

export function hasCalendar(userId) {
  const cal = parseBookingLink(getProfile(userId).booking_link);
  if (!cal) return false;
  return cal.provider === 'calcom' || !!calendlyToken(userId);
}

/**
 * Dynamic variables for a voice call: the times the assistant may offer.
 * Always both keys, so Retell never reads a literal {{placeholder}}.
 */
export async function calendarVars(userId) {
  const offers = hasCalendar(userId) ? await offerTimes(userId, { count: 2 }) : [];
  return {
    calendar_connected: offers.length ? 'yes' : 'no',
    available_times: offers.length ? `${offers.map(o => o.label).join(', or ')}, Malaysia time` : '',
    // For the booking tool: the exact time to pass back for each offer.
    available_slot_codes: offers.map(o => `${o.label} = ${o.start}`).join('; '),
  };
}

/**
 * Book a free time on the account's calendar so it lands in the host's own
 * calendar (the provider sends its own confirmation to both). Returns
 * { ok: true, provider, id, location } or { ok: false, reason }.
 */
export async function bookOnCalendar(userId, { start, name, email, notes }) {
  const cal = parseBookingLink(getProfile(userId).booking_link);
  if (!cal) return { ok: false, reason: 'no calendar' };
  try {
    if (cal.provider === 'calcom') {
      // Notes go in metadata, not a booking field: an event type without a
      // "notes" question would reject the booking.
      const metadata = { source: 'EIAAW SalesAgent voice assistant' };
      if (notes) metadata.notes = String(notes).slice(0, 480);
      const body = { start, eventTypeSlug: cal.slug, attendee: { name, email, timeZone: TIME_ZONE }, metadata };
      if (cal.username) body.username = cal.username;
      if (cal.teamSlug) body.teamSlug = cal.teamSlug;
      if (cal.organizationSlug) body.organizationSlug = cal.organizationSlug;
      const r = await fetch(`${CALCOM}/v2/bookings`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cal-api-version': '2026-02-25' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, reason: `cal.com ${r.status}` };
      const b = Array.isArray(data?.data) ? data.data[0] : data?.data;
      cache.delete(userId);
      return { ok: true, provider: 'calcom', id: b?.uid || b?.id || null, location: typeof b?.location === 'string' && /^https:\/\//.test(b.location) ? b.location : null };
    }
    const token = calendlyToken(userId);
    if (!token) return { ok: false, reason: 'no calendly token' };
    const uri = await calendlyEventType(userId, cal, token);
    const r = await fetch(`${CALENDLY}/invitees`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ event_type: uri, start_time: start, invitee: { name, email, timezone: TIME_ZONE } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: `calendly ${r.status}` };
    cache.delete(userId);
    return { ok: true, provider: 'calendly', id: data?.resource?.uri || null, location: null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export const __testing = { clearCache: () => cache.clear() };
