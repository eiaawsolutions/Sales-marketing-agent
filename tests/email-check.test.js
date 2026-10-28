import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const check = await import('../src/services/email-check.js');

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = realFetch;
  process.env.REACHER_URL = 'http://reacher.railway.internal:8080';
  delete process.env.REACHER_SECRET;
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.REACHER_URL;
  delete process.env.REACHER_SECRET;
});

const out = (is_reachable, extra = {}) => ({ input: 'a@b.example', is_reachable, misc: { is_disposable: false, is_role_account: false }, mx: { accepts_mail: true }, smtp: { can_connect_smtp: true, is_catch_all: false, is_deliverable: is_reachable === 'safe', is_disabled: false, has_full_inbox: false }, ...extra });

test("Reacher's answer is read as deliverable, risky, undeliverable or unknown", () => {
  assert.equal(check.verdictOf(out('safe')).verdict, 'deliverable');
  assert.equal(check.verdictOf(out('invalid')).verdict, 'undeliverable');
  assert.equal(check.verdictOf(out('risky', { smtp: { is_catch_all: true } })).verdict, 'risky');
  assert.equal(check.verdictOf(out('unknown')).verdict, 'unknown');
  assert.equal(check.verdictOf({}).verdict, 'unknown');
});

test('a throwaway address or a disabled mailbox is undeliverable', () => {
  assert.equal(check.verdictOf(out('risky', { misc: { is_disposable: true } })).verdict, 'undeliverable');
  assert.equal(check.verdictOf(out('risky', { smtp: { is_disabled: true } })).verdict, 'undeliverable');
});

test('a domain that takes no email is named as the reason', () => {
  assert.match(check.verdictOf(out('invalid', { mx: { accepts_mail: false } })).reason, /does not receive email/);
});

test('the check asks Reacher, with the shared secret when one is set', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(out('safe')), { status: 200 });
  };
  process.env.REACHER_SECRET = 'shared';
  const r = await check.checkMailbox('shufen.lee@velora.example');
  assert.equal(r.verdict, 'deliverable');
  assert.equal(calls[0].url, 'http://reacher.railway.internal:8080/v1/check_email');
  assert.deepEqual(calls[0].body, { to_email: 'shufen.lee@velora.example' });
  assert.equal(calls[0].headers['x-reacher-secret'], 'shared');
});

test('when the check cannot run the answer is unknown, never undeliverable', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await check.checkMailbox('a@b.example')).verdict, 'unknown');
  globalThis.fetch = async () => new Response('oops', { status: 500 });
  assert.equal((await check.checkMailbox('a@b.example')).verdict, 'unknown');
  delete process.env.REACHER_URL;
  assert.equal((await check.checkMailbox('a@b.example')).verdict, 'unknown');
});

test('the self-test says whether outbound SMTP (port 25) is open', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(out('invalid', { smtp: { can_connect_smtp: true } })), { status: 200 });
  assert.deepEqual(await check.probeSmtp('postmaster@eiaawsolutions.com'), { configured: true, ok: true, smtpOpen: true });
  globalThis.fetch = async () => new Response(JSON.stringify(out('unknown', { smtp: { can_connect_smtp: false } })), { status: 200 });
  assert.equal((await check.probeSmtp('postmaster@eiaawsolutions.com')).smtpOpen, false);
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal((await check.probeSmtp('postmaster@eiaawsolutions.com')).ok, false);
  delete process.env.REACHER_URL;
  assert.deepEqual(await check.probeSmtp('x@y.example'), { configured: false, ok: false });
});
