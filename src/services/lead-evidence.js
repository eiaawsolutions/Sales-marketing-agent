/**
 * Adds evidence to open-web search candidates before the verification gate.
 *
 *  1. The search found the person but not their email → read their company's
 *     own website for an address it publishes (site-reader.js).
 *  2. Every address → ask its mail server whether it accepts mail
 *     (email-check.js). An address the server refuses is discarded.
 *
 * Both are self-hosted services and both are optional: with neither set up
 * this changes nothing. It never adds a guessed address and never relaxes the
 * gate. A lead it cannot support is still discarded by isVerified().
 */
import { findPublishedEmail, isSiteReaderConfigured, pingSiteReader } from './site-reader.js';
import { checkMailbox, isEmailCheckConfigured, probeSmtp } from './email-check.js';

// The whole batch, while the person who pressed "Run" waits. Work not started
// by then is skipped; a lead left without an email is discarded as before.
export const EVIDENCE_BUDGET_MS = 60_000;
const CONCURRENCY = 3;

async function strengthen(lead, deadline) {
  if (!String(lead.email || '').trim() && isSiteReaderConfigured() && Date.now() < deadline) {
    const found = await findPublishedEmail(lead, { deadline }).catch(() => null);
    if (found) {
      lead.email = found.email;
      lead.email_found_on = found.page;
      const sources = Array.isArray(lead.verification_sources) ? lead.verification_sources : [];
      if (!sources.includes(found.page)) lead.verification_sources = [...sources, found.page];
    }
  }
  const email = String(lead.email || '').trim();
  if (email && isEmailCheckConfigured() && Date.now() < deadline) {
    lead.mailbox_check = await checkMailbox(email);
    if (lead.mailbox_check.verdict === 'undeliverable') lead.evidence_reject = `mailbox check: ${lead.mailbox_check.reason}`;
  }
}

export async function strengthenLeads(leads, { budgetMs = EVIDENCE_BUDGET_MS } = {}) {
  if (!isSiteReaderConfigured() && !isEmailCheckConfigured()) return;
  const work = (Array.isArray(leads) ? leads : []).filter(l => l && typeof l === 'object');
  const deadline = Date.now() + budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < work.length) await strengthen(work[next++], deadline);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
}

// The address the mailbox self-test checks. It is on our own domain, so the
// only mail server contacted is ours (Cloudflare Email Routing).
const SMTP_PROBE = () => process.env.REACHER_PROBE_EMAIL || 'postmaster@eiaawsolutions.com';

/** Are the website reader and mailbox check up? For Settings and the boot log. */
export async function leadToolsStatus() {
  const [siteReader, mailboxCheck] = await Promise.all([pingSiteReader(), probeSmtp(SMTP_PROBE())]);
  return { site_reader: siteReader, mailbox_check: mailboxCheck };
}

export async function logLeadToolsStatus() {
  const { site_reader: r, mailbox_check: m } = await leadToolsStatus();
  console.log(`[lead-tools] website reader: ${!r.configured ? 'off (CRAWL4AI_URL / CRAWL4AI_API_TOKEN not set)' : r.ok ? `ok (Crawl4AI ${r.version})` : `unreachable (${r.error})`}`);
  console.log(`[lead-tools] mailbox check: ${!m.configured ? 'off (REACHER_URL not set)' : !m.ok ? `unreachable (${m.error})` : m.smtpOpen ? 'ok, outbound port 25 open' : 'ok, but outbound port 25 is blocked: every address will read "unknown"'}`);
}
