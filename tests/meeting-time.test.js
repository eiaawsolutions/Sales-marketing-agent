import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetingTime } from '../src/services/meeting-time.js';

// Thursday 29 October 2026, 11:00 MYT.
const NOW = new Date('2026-10-29T03:00:00Z');
const myt = (iso) => new Date(`${iso}+08:00`).toISOString();
const p = (t) => parseMeetingTime(t, NOW)?.toISOString() ?? null;

test('an explicit date wins over the weekday, and its day number is not the hour', () => {
  assert.equal(p('Thursday 5 November at 3 pm'), myt('2026-11-05T15:00:00'));
  assert.equal(p('Friday 6 November, 10am'), myt('2026-11-06T10:00:00'), 'not the Friday tomorrow');
  assert.equal(p('Nov 6th at 10:30 a.m.'), myt('2026-11-06T10:30:00'));
  assert.equal(p('6 November at 3'), myt('2026-11-06T15:00:00'), 'a bare business-hours number is pm');
});

test('a date earlier in the year means next year', () => {
  assert.equal(p('5 January 9am'), myt('2027-01-05T09:00:00'));
});

test('relative times still work', () => {
  assert.equal(p('Thursday at 3pm'), myt('2026-11-05T15:00:00'), 'the same weekday means next week');
  assert.equal(p('tomorrow 10am'), myt('2026-10-30T10:00:00'));
  assert.equal(p('today 4pm'), myt('2026-10-29T16:00:00'));
});

test('an exact ISO time from the calendar is taken as is; past or unclear times are refused', () => {
  assert.equal(p('2026-11-05T07:00:00.000Z'), '2026-11-05T07:00:00.000Z');
  assert.equal(p('2026-10-01T07:00:00.000Z'), null);
  assert.equal(p('today 9am'), null, 'already past');
  assert.equal(p('sometime soon'), null);
  assert.equal(p(''), null);
});

test('"next week", a "maybe" and a time range are read the way a person means them', () => {
  assert.equal(p('Friday next week at 3pm'), myt('2026-11-06T15:00:00'), 'next week\'s Friday, not tomorrow');
  assert.equal(p('Friday at 3, maybe 4'), myt('2026-10-30T15:00:00'), '"maybe" is not the month of May');
  assert.equal(p('Friday 2 to 3pm'), myt('2026-10-30T14:00:00'), 'a range starts at its first time');
  assert.equal(p('Friday 10-11am'), myt('2026-10-30T10:00:00'));
  assert.equal(p('May 5 at 10am'), myt('2027-05-05T10:00:00'), 'the month of May still works');
});
