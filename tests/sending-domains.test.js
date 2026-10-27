import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Sending from a customer's own domain: EIAAW adds it to Resend, hands the
// customer the DNS records, and enables it for that one account only once
// Resend says it is verified. Superadmin only.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-domains-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { senderFor } = await import('../src/services/account-profile.js');

const realFetch = globalThis.fetch;
let domains = [], verifyCalls = 0, flipOnVerify = false;
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

const RECORDS = [
  { record: 'SPF', type: 'MX', name: 'send', value: 'feedback-smtp.ap-northeast-1.amazonses.com', priority: 10, status: 'not_started' },
  { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: 'p=MIGf...', status: 'not_started' },
];

beforeEach(() => {
  for (const t of ['sessions', 'account_profiles', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'verified_sender_domains_%'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan, email_verified) VALUES (1, 'hq', 'hq@example.com', 'x', 'superadmin', 'active', 'business', 1)").run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan, email_verified) VALUES (4, 'plain', 'plain@example.com', 'x', 'user', 'active', 'business', 1)").run();
  for (const [token, uid] of [['tok_hq', 1], ['tok_user', 4]]) db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(token, uid);
  for (const id of [2, 3]) db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'business')").run(id, `u${id}`, `o${id}@example.com`);
  db.prepare("INSERT INTO account_profiles (user_id, business_name, sender_name, offer, from_email) VALUES (2, 'The Leadership Lab', 'Aaron Joseph', 'Programmes', 'aaron@tll.example')").run();
  domains = []; verifyCalls = 0; flipOnVerify = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.resend.com/domains')) return realFetch(url, init);
    assert.equal(init.headers.Authorization, 'Bearer re_test_key_123');
    const method = init.method || 'GET';
    if (u === 'https://api.resend.com/domains' && method === 'GET') return new Response(JSON.stringify({ data: domains.map(({ records, ...d }) => d) }));
    if (u === 'https://api.resend.com/domains' && method === 'POST') {
      const d = { id: `d_${domains.length + 1}`, name: JSON.parse(init.body).name, status: 'not_started', records: RECORDS };
      domains.push(d);
      return new Response(JSON.stringify(d), { status: 201 });
    }
    const m = u.match(/\/domains\/(d_\d+)(\/verify)?$/);
    const d = domains.find(x => x.id === m?.[1]);
    if (m?.[2]) { verifyCalls++; if (flipOnVerify) d.status = 'verified'; return new Response(JSON.stringify({ object: 'domain', id: d.id })); }
    return new Response(JSON.stringify(d));
  };
});

async function as(role, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const token = role === 'superadmin' ? 'tok_hq' : 'tok_user';
  const call = async (method, p, body) => { const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try { await fn(call); } finally { s.close(); }
}

test('adding a domain returns the DNS records for the customer, and nothing is enabled yet', async () => {
  await as('superadmin', async (call) => {
    const r = await call('POST', '/api/users/2/sending-domain', { domain: 'TLL.example' });
    assert.equal(r.status, 200);
    assert.equal(r.body.domain, 'tll.example');
    assert.equal(r.body.records.length, 2);
    assert.equal(r.body.enabled_for_account, false);
    assert.equal((await call('POST', '/api/users/2/sending-domain/check', { domain: 'tll.example' })).body.enabled_for_account, false, 'records not in place yet');
  });
  assert.equal(senderFor(2).from, undefined, 'mail still goes from EIAAW\'s domain under their name');
  assert.equal(verifyCalls, 1);
});

test('once Resend verifies it, the account sends from its own address — and no other account can claim it', async () => {
  flipOnVerify = true;
  await as('superadmin', async (call) => {
    await call('POST', '/api/users/2/sending-domain', { domain: 'tll.example' });
    const r = await call('POST', '/api/users/2/sending-domain/check', { domain: 'tll.example' });
    assert.equal(r.body.status, 'verified');
    assert.equal(r.body.enabled_for_account, true);
    assert.equal((await call('POST', '/api/users/3/sending-domain/check', { domain: 'tll.example' })).status, 409);
  });
  assert.equal(senderFor(2).from, 'aaron@tll.example');
  await as('superadmin', async (call) => { await call('DELETE', '/api/users/2/sending-domain?domain=tll.example'); });
  assert.equal(senderFor(2).from, undefined);
});

test('only HQ manages sending domains; bad and platform domains are refused', async () => {
  await as('user', async (call) => {
    assert.equal((await call('POST', '/api/users/2/sending-domain', { domain: 'tll.example' })).status, 403);
  });
  await as('superadmin', async (call) => {
    assert.equal((await call('POST', '/api/users/2/sending-domain', { domain: 'not a domain' })).status, 400);
    assert.equal((await call('POST', '/api/users/2/sending-domain', { domain: 'eiaawsolutions.com' })).status, 502);
    assert.equal((await call('POST', '/api/users/2/sending-domain/check', { domain: 'eiaawsolutions.com' })).status, 409, 'never enabled for a customer');
  });
});
