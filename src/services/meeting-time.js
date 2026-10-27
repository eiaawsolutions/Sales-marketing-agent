/**
 * Turn the time a voice assistant agreed with a prospect into an instant.
 * Everything is Malaysia time (UTC+8, no daylight saving).
 *
 * Accepts an exact ISO time (what the assistant passes back for a time it
 * offered from the calendar), an explicit date ("Thursday 5 November at
 * 3 pm", "Nov 6, 10am") or a relative one ("tomorrow 10am", "Thursday at
 * 3pm", "next week"). A date's day number is never read as the hour, and a
 * named date wins over a weekday. Returns null for anything in the past or
 * not understood — the assistant then asks again rather than booking a guess.
 */
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:\\.)?';

function readTime(lower) {
  // A range ("2 to 3pm", "10-11am") starts at its first time, in the range's am/pm.
  let m = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:to|-|–|until)\s*\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (m) {
    let h = parseInt(m[1], 10);
    const pm = m[3].startsWith('p');
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return [h, parseInt(m[2] || '0', 10)];
  }
  // "3pm", "3:30 pm", "10 a.m."
  m = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (m) {
    let h = parseInt(m[1], 10);
    const pm = m[3].startsWith('p');
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return [h, parseInt(m[2] || '0', 10)];
  }
  // "at 3", "at 15:00"
  m = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/) || lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (h < 8) h += 12; // business hours: "at 3" is 3 pm
    return [h, parseInt(m[2] || '0', 10)];
  }
  return [10, 0];
}

export function parseMeetingTime(text, now = new Date()) {
  if (!text || typeof text !== 'string') return null;

  // An exact instant with its zone, as offered from the calendar.
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text.trim())) {
    const d = new Date(text.trim());
    return !Number.isNaN(d.getTime()) && d > now ? d : null;
  }

  const lower = text.toLowerCase();
  const myt = new Date(now.getTime() + MYT_OFFSET_MS);
  let y = myt.getUTCFullYear();
  let mo = myt.getUTCMonth();
  let d = myt.getUTCDate();
  let found = false;

  // Named date: "5 November", "5th Nov", "November 5", "Nov 5th".
  const dm = lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`))
    || lower.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  let rest = lower;
  if (dm) {
    const dayNum = /^\d/.test(dm[1]) ? parseInt(dm[1], 10) : parseInt(dm[2], 10);
    const monName = /^\d/.test(dm[1]) ? dm[2] : dm[1];
    const monthIdx = MONTHS.indexOf(monName.slice(0, 3));
    if (monthIdx >= 0 && dayNum >= 1 && dayNum <= 31) {
      mo = monthIdx; d = dayNum; found = true;
      const sameYear = Date.UTC(y, mo, d) >= Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate());
      if (!sameYear) y += 1;
      rest = lower.replace(dm[0], ' ');
    }
  }

  if (!found) {
    const dayIdx = DAYS.findIndex(n => lower.includes(n));
    if (lower.includes('tomorrow')) { d += 1; found = true; }
    else if (lower.includes('today')) { found = true; }
    else if (dayIdx >= 0 && /\bnext\s+week\b|\bweek\s+after\b/.test(lower)) {
      // "Friday next week": that weekday in the week starting next Monday.
      const toNextMonday = 8 - (myt.getUTCDay() || 7);
      d += toNextMonday + ((dayIdx + 6) % 7); found = true;
    } else if (dayIdx >= 0) {
      let ahead = dayIdx - myt.getUTCDay();
      if (ahead <= 0) ahead += 7;
      d += ahead; found = true;
    } else if (lower.includes('next week')) {
      d += 8 - myt.getUTCDay(); found = true;
    }
  }
  if (!found) return null;

  const [h, min] = readTime(rest);
  if (h > 23 || min > 59) return null;
  const at = new Date(Date.UTC(y, mo, d, h, min) - MYT_OFFSET_MS);
  return at > now ? at : null;
}
