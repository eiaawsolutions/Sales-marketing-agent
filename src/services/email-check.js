/**
 * Asks the self-hosted Reacher service whether an address accepts mail.
 * Reacher talks to the address's mail server and stops before anything is
 * sent. It runs as its own Railway service on the private network
 * (REACHER_URL, plus REACHER_SECRET when its header secret is set). With
 * REACHER_URL unset the check is off.
 *
 * A check that cannot run (service down, outbound port 25 blocked, a mail
 * server that will not say) is 'unknown', and unknown never costs a lead:
 * the address was already found published on a real page.
 */
const CHECK_TIMEOUT_MS = 20_000;

export function isEmailCheckConfigured() {
  return !!process.env.REACHER_URL;
}

/** @returns {{ verdict: 'deliverable' | 'risky' | 'undeliverable' | 'unknown', reason: string }} */
export function verdictOf(out) {
  if (out?.misc?.is_disposable) return { verdict: 'undeliverable', reason: 'a throwaway address' };
  if (out?.smtp?.is_disabled) return { verdict: 'undeliverable', reason: 'the mailbox is disabled' };
  switch (out?.is_reachable) {
    case 'safe':
      return { verdict: 'deliverable', reason: 'the mail server accepts this address' };
    case 'invalid':
      return { verdict: 'undeliverable', reason: out?.mx?.accepts_mail === false ? 'the domain does not receive email' : 'the mail server says this address does not exist' };
    case 'risky':
      return { verdict: 'risky', reason: out?.smtp?.is_catch_all ? 'the domain accepts every address, so this one cannot be confirmed' : 'the mailbox may be full' };
    default:
      return { verdict: 'unknown', reason: 'the mail server did not say' };
  }
}

async function askReacher(email) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.REACHER_SECRET) headers['x-reacher-secret'] = process.env.REACHER_SECRET;
  const res = await fetch(`${process.env.REACHER_URL.replace(/\/+$/, '')}/v1/check_email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ to_email: email }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function checkMailbox(email) {
  if (!isEmailCheckConfigured()) return { verdict: 'unknown', reason: 'mailbox check is not set up' };
  try {
    return verdictOf(await askReacher(email));
  } catch (err) {
    return { verdict: 'unknown', reason: `mailbox check unavailable (${err.message})` };
  }
}

/**
 * For Settings and the startup log. Checks an address on a domain we own, so
 * the only mail server contacted is our own; can_connect_smtp then says
 * whether this host may open outbound port 25 at all.
 */
export async function probeSmtp(email) {
  if (!isEmailCheckConfigured()) return { configured: false, ok: false };
  try {
    const out = await askReacher(email);
    return { configured: true, ok: true, smtpOpen: out?.smtp?.can_connect_smtp === true };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}
