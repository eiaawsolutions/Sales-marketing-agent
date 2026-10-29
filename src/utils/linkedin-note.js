// LinkedIn takes at most 200 characters in a connection note (300 is the
// Premium limit, so 200 fits every account). No links: the team sends it from
// their own account, and a link reads as spam there.
export const LINKEDIN_NOTE_MAX = 200;

// What the model is asked for. It counts characters loosely, so it aims under
// the limit and fitLinkedinNote() is the hard stop.
export const LINKEDIN_NOTE_RULE = `at most 180 characters, about 25 words (LinkedIn stops a note at ${LINKEDIN_NOTE_MAX}), no link, signed with the sender's first name only — the sender sends it from their own account`;

const SIGN_OFF = /^(?:[-–—~]|(?:cheers|best|regards|thanks|thank you|warmly)\b)/i;

// Cut a note to the limit on whole sentences: the sign-off goes first
// (LinkedIn shows who sent it), then sentences from the middle, so the opening
// line and the closing ask stay. Text that still doesn't fit is cut at the
// last sentence end, or else on a word.
export function fitLinkedinNote(text) {
  const s = String(text || '').replace(/\{\{CALL_LINK\}\}/g, '').replace(/https?:\/\/\S+/g, '').replace(/[ \t]+/g, ' ').trim();
  if (s.length <= LINKEDIN_NOTE_MAX) return s;
  const parts = (s.match(/[^.!?]+(?:[.!?]+["'’”)]*|$)/g) || []).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1 && SIGN_OFF.test(parts.at(-1))) parts.pop();
  while (parts.join(' ').length > LINKEDIN_NOTE_MAX && parts.length > 2) parts.splice(-2, 1);
  const out = parts.join(' ');
  if (out.length <= LINKEDIN_NOTE_MAX) return out;
  const head = out.slice(0, LINKEDIN_NOTE_MAX + 1);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end > LINKEDIN_NOTE_MAX / 2) return head.slice(0, end + 1);
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head.slice(0, LINKEDIN_NOTE_MAX)).trim();
}
