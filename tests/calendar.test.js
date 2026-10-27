import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Meeting times come from the account's own booking calendar (Cal.com, or
// Calendly with the account's token). Only times the calendar says are free
// are offered, minus meetings already booked here; offers are spread over
// different days in business hours, Malaysia time. When the calendar cannot
// be read, nothing is offered — the assistant asks instead of guessing.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-cal-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const { default: db } = await import('../src/db/index.js');
const cal = await import('../src/services/calendar.js');
const { saveProfile, getProfile } = await import('../src/services/account-profile.js');

const realFetch = globalThis.fetch;
let calls = [];
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

// Monday 2 November 2026, 09:00 MYT (01:00 UTC).
const NOW = new Date('2026-11-02T01:00:00Z');
const myt = (day, hhmm) => new Date(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+08:00`).toISOString();

function calcomReturns(slots, { status = 200 } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://api.cal.com/v2/slots')) {
      const data = {};
      for (const s of slots) { const k = s.slice(0, 10); (data[k] ||= []).push({ start: s }); }
      return new Response(JSON.stringify({ status: 'success', data }), { status });
    }
    if (String(url) === 'https://api.cal.com/v2/bookings') {
      return new Response(JSON.stringify({ status: 'success', data: { id: 9, uid: 'bk_123', location: 'https://cal.com/video/abc' } }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  };
}

beforeEach(() => {
  for (const t of ['appointments', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'calendly_event_type_%'").run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'tll', 'aaron@tll.example', 'x', 'user', 'active', 'business')").run();
  saveProfile(2, { business_name: 'The Leadership Lab', offer: 'Leadership programmes', booking_link: 'https://cal.com/aaron-tll/30min' });
  cal.__testing.clearCache();
  calls = [];
});

test('booking links are recognised for Cal.com (personal, team, org) and Calendly, https only', () => {
  assert.deepEqual(cal.parseBookingLink('https://cal.com/aaron/30min?x=1'), { provider: 'calcom', username: 'aaron', slug: '30min' });
  assert.deepEqual(cal.parseBookingLink('https://cal.com/team/tll/intro'), { provider: 'calcom', teamSlug: 'tll', slug: 'intro' });
  assert.deepEqual(cal.parseBookingLink('https://acme.cal.com/aaron/intro'), { provider: 'calcom', organizationSlug: 'acme', username: 'aaron', slug: 'intro' });
  assert.equal(cal.parseBookingLink('https://calendly.com/aaron/30min').provider, 'calendly');
  assert.equal(cal.parseBookingLink('http://cal.com/aaron/30min'), null);
  assert.equal(cal.parseBookingLink('https://meet.google.com/abc-defg-hij'), null);
  assert.equal(saveProfile(2, { booking_link: 'https://zoom.us/j/123' }).errors.booking_link !== undefined, true);
});

test('offered times are free on the calendar, on different days, in business hours', async () => {
  calcomReturns([myt(3, '08:00'), myt(3, '10:00'), myt(3, '15:00'), myt(4, '10:00'), myt(4, '16:00'), myt(5, '14:30'), myt(5, '20:00')]);
  const offers = await cal.offerTimes(2, { count: 3, now: NOW });
  assert.equal(offers.length, 3);
  assert.deepEqual(offers.map(o => o.start), [myt(3, '15:00'), myt(4, '10:00'), myt(5, '14:30')]);
  assert.equal(offers[0].label, 'Tuesday 3 November at 3:00 pm');
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get('username'), 'aaron-tll');
  assert.equal(q.get('eventTypeSlug'), '30min');
  assert.equal(q.get('timeZone'), 'Asia/Kuala_Lumpur');
  assert.equal(calls[0].init.headers['cal-api-version'], '2024-09-04');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'no key is sent to Cal.com');
});

test('a time already booked here is never offered, even if the calendar shows it free', async () => {
  calcomReturns([myt(3, '15:00'), myt(3, '16:00')]);
  db.prepare("INSERT INTO appointments (user_id, title, scheduled_at, duration_minutes, status) VALUES (2, 'Booked by the agent', ?, 30, 'scheduled')").run(myt(3, '15:00'));
  const offers = await cal.offerTimes(2, { count: 3, now: NOW });
  assert.deepEqual(offers.map(o => o.start), [myt(3, '16:00')]);
  assert.equal(await cal.isFree(2, myt(3, '15:00'), { now: NOW }), false);
  assert.equal(await cal.isFree(2, myt(3, '16:00'), { now: NOW }), true);
});

test('when the calendar cannot be read, nothing is offered and the call variables say so', async () => {
  calcomReturns([], { status: 500 });
  assert.deepEqual(await cal.offerTimes(2, { now: NOW }), []);
  cal.__testing.clearCache();
  const vars = await cal.calendarVars(2);
  assert.deepEqual(vars, { calendar_connected: 'no', available_times: '', available_slot_codes: '' });
  assert.equal(await cal.isFree(2, myt(3, '15:00'), { now: NOW }), null, 'unknown, not "busy"');
});

test('the call variables name two real times', async () => {
  const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  calcomReturns([`${day(2)}T07:00:00.000Z`, `${day(3)}T02:00:00.000Z`]);
  const vars = await cal.calendarVars(2);
  assert.equal(vars.calendar_connected, 'yes');
  assert.match(vars.available_times, /, or .*Malaysia time$/);
});

test('booking on Cal.com sends the attendee and the event, with no key', async () => {
  calcomReturns([]);
  const r = await cal.bookOnCalendar(2, { start: myt(3, '15:00'), name: 'Grace Tan', email: 'grace@lumina.example', notes: 'Need: 40 new unit managers' });
  assert.deepEqual(r, { ok: true, provider: 'calcom', id: 'bk_123', location: 'https://cal.com/video/abc' });
  const post = calls.find(c => c.url === 'https://api.cal.com/v2/bookings');
  const body = JSON.parse(post.init.body);
  assert.equal(post.init.headers['cal-api-version'], '2026-02-25');
  assert.equal(body.eventTypeSlug, '30min');
  assert.equal(body.username, 'aaron-tll');
  assert.deepEqual(body.attendee, { name: 'Grace Tan', email: 'grace@lumina.example', timeZone: 'Asia/Kuala_Lumpur' });
  assert.equal(body.metadata.notes, 'Need: 40 new unit managers');
});

test('Calendly: the token is stored encrypted, never returned, and used to read free times', async () => {
  const token = 'eyJraWQiOi' + 'x'.repeat(60);
  const saved = saveProfile(2, { booking_link: 'https://calendly.com/aaron-tll/30min', calendly_token: token });
  assert.equal(saved.profile.calendly_connected, true);
  assert.equal(saved.profile.calendly_token, undefined);
  assert.equal(JSON.stringify(getProfile(2)).includes(token), false);
  const stored = db.prepare('SELECT calendly_token FROM account_profiles WHERE user_id = 2').get().calendly_token;
  assert.notEqual(stored, token, 'encrypted at rest');

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    if (String(url) === 'https://api.calendly.com/users/me') return new Response(JSON.stringify({ resource: { uri: 'https://api.calendly.com/users/U1' } }));
    if (String(url).startsWith('https://api.calendly.com/event_types?')) {
      return new Response(JSON.stringify({ collection: [{ uri: 'https://api.calendly.com/event_types/E1', scheduling_url: 'https://calendly.com/aaron-tll/30min', slug: '30min' }] }));
    }
    if (String(url).startsWith('https://api.calendly.com/event_type_available_times?')) {
      assert.equal(new URL(url).searchParams.get('event_type'), 'https://api.calendly.com/event_types/E1');
      return new Response(JSON.stringify({ collection: [{ status: 'available', start_time: myt(4, '10:00') }] }));
    }
    return new Response('{}', { status: 404 });
  };
  const offers = await cal.offerTimes(2, { now: NOW });
  assert.deepEqual(offers.map(o => o.start), [myt(4, '10:00')]);

  assert.equal(saveProfile(2, { calendly_token: 'short' }).errors.calendly_token !== undefined, true);
  saveProfile(2, { calendly_token: null });
  assert.equal(getProfile(2).calendly_connected, false);
});
