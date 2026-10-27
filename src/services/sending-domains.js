/**
 * Sending from a customer's own domain ("In your setup").
 *
 * EIAAW adds the customer's domain to its Resend account, gives the customer
 * the DNS records Resend asks for (SPF, DKIM, and MX for bounces), and once
 * Resend reports the domain verified, allows that one domain for that one
 * account (settings verified_sender_domains_<userId>, read by
 * account-profile.js). Mail is never sent from a domain Resend has not
 * verified, so it never fails DMARC, and no account can send as another's
 * domain. Superadmin only (routes/users.js).
 */
import db from '../db/index.js';
import { resendApiKey } from '../utils/email.js';

const RESEND = 'https://api.resend.com';
const PLATFORM_DOMAIN = 'eiaawsolutions.com';

export function validDomain(v) {
  const d = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) ? d : null;
}

async function resend(method, path, body) {
  const key = resendApiKey();
  if (!key) throw new Error('The Resend API key is not configured.');
  const r = await fetch(`${RESEND}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.message || `Resend ${r.status}`);
  return data;
}

async function findDomain(domain) {
  const list = await resend('GET', '/domains');
  const hit = (list?.data || []).find(d => String(d.name).toLowerCase() === domain);
  return hit ? resend('GET', `/domains/${hit.id}`) : null;
}

function allowedFor(userId) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(`verified_sender_domains_${userId}`)?.value || '';
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function view(userId, domain, d) {
  return {
    domain,
    in_resend: !!d,
    status: d?.status || 'not added',
    records: (d?.records || []).map(r => ({ type: r.type, name: r.name, value: r.value, priority: r.priority ?? null, status: r.status || null })),
    enabled_for_account: allowedFor(userId).includes(domain),
    from_email: db.prepare('SELECT from_email FROM account_profiles WHERE user_id = ?').get(userId)?.from_email || null,
  };
}

/** Where a domain stands, for the account it would be enabled for. */
export async function domainState(userId, domain) {
  return view(userId, domain, await findDomain(domain));
}

/** Add the domain to Resend (if it is not there) and return the DNS records to send the customer. */
export async function addDomain(userId, domain) {
  if (domain === PLATFORM_DOMAIN) throw new Error('That is EIAAW\'s own domain.');
  let d = await findDomain(domain);
  if (!d) {
    const created = await resend('POST', '/domains', { name: domain });
    d = created?.records ? created : await resend('GET', `/domains/${created.id}`);
  }
  return view(userId, domain, d);
}

/**
 * Ask Resend to check the records; when it reports the domain verified,
 * allow it for this account (and only this one).
 */
export async function checkDomain(userId, domain) {
  if (domain === PLATFORM_DOMAIN) throw new Error("That is EIAAW's own domain.");
  let d = await findDomain(domain);
  if (!d) throw new Error('Add the domain first.');
  if (d.status !== 'verified') {
    await resend('POST', `/domains/${d.id}/verify`);
    d = await resend('GET', `/domains/${d.id}`);
  }
  if (d.status === 'verified') {
    const others = db.prepare("SELECT key FROM settings WHERE key LIKE 'verified_sender_domains_%' AND key <> ?").all(`verified_sender_domains_${userId}`)
      .filter(r => (db.prepare('SELECT value FROM settings WHERE key = ?').get(r.key)?.value || '').split(',').map(s => s.trim().toLowerCase()).includes(domain));
    if (others.length) throw new Error('That domain is already enabled for another account.');
    const list = [...new Set([...allowedFor(userId), domain])].join(',');
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(`verified_sender_domains_${userId}`, list);
  }
  return view(userId, domain, d);
}

/** Stop sending from the domain for this account (Resend keeps it). */
export function disableDomain(userId, domain) {
  const list = allowedFor(userId).filter(d => d !== domain);
  if (list.length) db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(`verified_sender_domains_${userId}`, list.join(','));
  else db.prepare('DELETE FROM settings WHERE key = ?').run(`verified_sender_domains_${userId}`);
}
