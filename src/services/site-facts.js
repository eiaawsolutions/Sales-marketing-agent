/**
 * Site facts for the public chatbots.
 *
 * The chatbots may only state what the EIAAW sites publish. Those facts used to
 * be hand-copied into the prompts, and every copy change on eiaawsolutions.com
 * or a product site had to be repeated here — it wasn't, and the bots drifted
 * (wrong prices, trials that no longer exist, a stale SMT agent list).
 *
 * Now the bots read the sites' own llms.txt truth surfaces, which are kept in
 * step with each page and its FAQ:
 *   - parent facts: https://eiaawsolutions.com/llms.txt, fetched live with a
 *     short TTL so a parent-site deploy reaches the chat without a deploy here.
 *     Invalid or failed fetches keep the last good copy, and the bundled
 *     snapshot is the floor, so chat never goes factless.
 *   - Sales Agent facts: this repo's public/llms.txt (ships with this code).
 */
import { readFileSync } from 'node:fs';

const PARENT_FACTS_URL = process.env.PARENT_FACTS_URL || 'https://eiaawsolutions.com/llms.txt';
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MIN_CHARS = 500;
const MAX_CHARS = 20000;

const readText = (relative) => normalise(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const PARENT_SNAPSHOT = readText('../prompts/parent-llms.snapshot.txt');
const SALES_AGENT_FACTS = readText('../../public/llms.txt');

let parentCache = null; // { text, fetchedAt }
let refreshing = null;

function normalise(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
}

/** A real parent llms.txt — not a 404 page, a Cloudflare challenge or a truncated body. */
export function isValidParentFacts(text) {
  return typeof text === 'string'
    && text.length >= MIN_CHARS
    && text.length <= MAX_CHARS
    && text.startsWith('# EIAAW Solutions')
    && text.includes('## Products');
}

/**
 * Stale-while-revalidate: once a copy is cached, visitors never wait on the
 * fetch — an expired copy is served while one background refresh runs. Only
 * the very first call (normally the boot-time warm-up) awaits the network.
 */
export async function getParentFacts({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!parentCache) return refreshParentFacts(fetchImpl, now);
  if (now() - parentCache.fetchedAt >= TTL_MS && !refreshing) {
    refreshing = refreshParentFacts(fetchImpl, now).finally(() => { refreshing = null; });
  }
  return parentCache.text;
}

async function refreshParentFacts(fetchImpl, now) {
  try {
    const res = await fetchImpl(PARENT_FACTS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/plain', 'user-agent': 'EIAAW-SalesAgent-Chatbot/1.0' },
    });
    const text = res.ok ? normalise(await res.text()) : '';
    if (!isValidParentFacts(text)) throw new Error(`unusable response (HTTP ${res.status}, ${text.length} chars)`);
    parentCache = { text, fetchedAt: now() };
  } catch (err) {
    const fallback = parentCache?.text || PARENT_SNAPSHOT;
    console.warn(`[site-facts] ${PARENT_FACTS_URL} unavailable (${err.message}); using ${parentCache ? 'last good copy' : 'bundled snapshot'}`);
    // Hold the fallback for one TTL window so an outage doesn't cost a fetch per message.
    parentCache = { text: fallback, fetchedAt: now() };
  }
  return parentCache.text;
}

export function getSalesAgentFacts() {
  return SALES_AGENT_FACTS;
}

/** Body of one "## Heading" section of an llms.txt, or '' when absent. */
export function extractSection(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

export function resetParentFactsCache() {
  parentCache = null;
  refreshing = null;
}
