/**
 * Reads a lead's company website through the self-hosted Crawl4AI service and
 * finds an email address the company itself publishes for that person.
 *
 * Never guesses. An address is used only when it is written on a page of the
 * company's own site, is on the company's domain, sits on a page that names
 * the person, and is the one address there that clearly belongs to them. The
 * page it was found on becomes the lead's evidence. Anything weaker returns
 * null, and the verification gate discards the lead exactly as before.
 *
 * Crawl4AI runs as its own Railway service on the private network
 * (CRAWL4AI_URL, CRAWL4AI_API_TOKEN). With either unset the reader is off.
 */
import { isRoleMailbox } from '../utils/normalize.js';

const PAGE_TIMEOUT_MS = 20_000;
const MAX_PAGES = 4;         // the site's own page, then up to three people pages
const MAX_LINKED_PAGES = 3;

// Words that are part of how a name is written, not part of the name.
const NOT_NAME = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'datuk', 'dato', 'datin', 'puan', 'encik', 'cik', 'haji', 'hj', 'hajah', 'ir', 'ts', 'bin', 'binti', 'bt']);
const PEOPLE_LINKS = [
  [/team|leadership|management|people|directors|board|founders?|staff|our-?story|who-?we-?are/i, 2],
  [/about|contact/i, 1],
];
const FILE = /\.(pdf|jpe?g|png|gif|svg|webp|avif|zip|docx?|xlsx?|pptx?)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
const INTERNAL_HOST = /(^|\.)(localhost|local|localdomain|internal|lan|home|corp|intranet)$/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function isSiteReaderConfigured() {
  const token = process.env.CRAWL4AI_API_TOKEN || '';
  return !!(process.env.CRAWL4AI_URL && token && !token.startsWith('secret://'));
}

// A cheap first check before a URL leaves Node. The crawler does the real
// check: Crawl4AI's egress broker resolves each host once and refuses every
// non-public IP. This stops obviously internal targets from being sent at all.
export function safeSiteUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host) || INTERNAL_HOST.test(host)) return null;
  u.hash = '';
  return u;
}

function words(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !NOT_NAME.has(w));
}

function emailsOn(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(EMAIL)) {
    const e = m[0].toLowerCase().replace(/^[._%+-]+/, '');
    if (!IMAGE.test(e)) found.add(e);
  }
  return [...found];
}

function sameSite(emailDomain, host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  return emailDomain === h || h.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${h}`);
}

// How many of the person's name words the address is built from. Short words
// (Ng, Ho, Wu) count only as a whole part of the address, never as letters
// inside a longer one.
function nameScore(email, nameWords) {
  const local = email.split('@')[0];
  const letters = local.replace(/[^a-z]/g, '');
  const parts = local.split(/[._+-]+/);
  return nameWords.filter(w => (w.length >= 3 && letters.includes(w)) || parts.includes(w)).length;
}

/** The person's work address on this page, or null when it is not clear-cut. */
export function matchPublishedEmail(name, pageText, siteHost) {
  const nameWords = words(name);
  if (!nameWords.length) return null;
  const text = String(pageText || '');
  const emails = emailsOn(text).filter(e => sameSite(e.split('@')[1], String(siteHost || '')) && !isRoleMailbox(e));
  if (!emails.length) return null;
  // The name must be written on the page itself, not only inside an address.
  const onPage = new Set(words(text.replace(EMAIL, ' ')));
  if (!nameWords.every(w => onPage.has(w))) return null;
  const ranked = emails.map(e => ({ e, score: nameScore(e, nameWords) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
  return ranked[0].e;
}

/** Team, leadership, about and contact pages linked from the site's own page. */
export function peoplePages(markdown, site) {
  const host = site.hostname.replace(/^www\./, '');
  const seen = new Set([site.pathname.replace(/\/+$/, '') || '/']);
  const ranked = [];
  for (const [, text, href] of String(markdown || '').matchAll(LINK)) {
    let u;
    try { u = new URL(href, site); } catch { continue; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname.replace(/^www\./, '') !== host) continue;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    if (FILE.test(path) || seen.has(path)) continue;
    const rank = PEOPLE_LINKS.find(([re]) => re.test(`${text} ${path}`))?.[1];
    if (!rank) continue;
    seen.add(path);
    u.hash = '';
    u.search = '';
    ranked.push({ u, rank, order: ranked.length });
  }
  return ranked.sort((a, b) => b.rank - a.rank || a.order - b.order).slice(0, MAX_LINKED_PAGES).map(r => r.u);
}

/** For Settings and the startup log: is the service up, and which version. */
export async function pingSiteReader() {
  if (!isSiteReaderConfigured()) return { configured: false, ok: false };
  try {
    const res = await fetch(`${process.env.CRAWL4AI_URL.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(10_000) });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { configured: true, ok: true, version: json.version || '' } : { configured: true, ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

async function readPage(url) {
  const res = await fetch(`${process.env.CRAWL4AI_URL.replace(/\/+$/, '')}/md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CRAWL4AI_API_TOKEN}` },
    body: JSON.stringify({ url, f: 'raw' }),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Website reader ${res.status}`);
  const json = await res.json();
  return typeof json?.markdown === 'string' ? json.markdown : '';
}

/**
 * Reads the lead's company site for an address it publishes for them.
 * @returns {Promise<{ email: string, page: string } | null>}
 */
export async function findPublishedEmail(lead, { deadline = Infinity } = {}) {
  if (!isSiteReaderConfigured()) return null;
  const site = safeSiteUrl(lead?.company_website);
  if (!site || !lead?.name) return null;
  const queue = [site];
  for (let i = 0; i < queue.length && i < MAX_PAGES; i++) {
    if (Date.now() >= deadline) break;
    const url = queue[i].href;
    let markdown;
    try {
      markdown = await readPage(url);
    } catch (err) {
      console.warn(`[site-reader] could not read ${url}: ${err.message}`);
      continue;
    }
    const email = matchPublishedEmail(lead.name, markdown, site.hostname);
    if (email) return { email, page: url };
    if (i === 0) queue.push(...peoplePages(markdown, site));
  }
  return null;
}
