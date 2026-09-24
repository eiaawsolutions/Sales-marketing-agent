import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Throwaway database and no Stripe key: the checkout route must reject before
// it ever reaches Stripe when the Terms box was not ticked.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-checkout-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.STRIPE_SECRET_KEY;

const { default: express } = await import('express');
const { default: billingRouter } = await import('../src/routes/billing.js');
const { readTermsAcceptance, TERMS_VERSION, PRIVACY_VERSION } = await import('../src/config/legal.js');
const { default: db } = await import('../src/db/index.js');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/billing', billingRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const checkout = (body) => fetch(`${base}/api/billing/checkout`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const buyer = { plan: 'pro', email: 'buyer@example.com', username: 'buyer1', displayName: 'Buyer' };

test('checkout without terms acceptance is rejected with 400', async () => {
  const res = await checkout(buyer);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Terms of Service/);
});

test('checkout with termsAccepted: false is rejected', async () => {
  const res = await checkout({ ...buyer, termsAccepted: false });
  assert.equal(res.status, 400);
});

test('checkout with an unparseable termsAcceptedAt is rejected', async () => {
  const res = await checkout({ ...buyer, termsAcceptedAt: 'yes' });
  assert.equal(res.status, 400);
});

test('checkout with acceptance gets past the gate (then stops at the missing Stripe key)', async () => {
  const res = await checkout({ ...buyer, termsAccepted: true, termsAcceptedAt: new Date().toISOString() });
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.match(data.error, /Stripe not configured/);
});

test('acceptance record uses the server clock and the current document versions', () => {
  const now = new Date('2026-09-25T04:00:00.000Z');
  assert.deepEqual(readTermsAcceptance({ termsAccepted: true, termsAcceptedAt: '1999-01-01T00:00:00Z' }, now), {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptedAt: '2026-09-25T04:00:00.000Z',
  });
  // Older cached landing pages send only the timestamp.
  assert.ok(readTermsAcceptance({ termsAcceptedAt: '2026-09-25T03:59:00.000Z' }, now));
  assert.equal(readTermsAcceptance({}, now), null);
  assert.equal(readTermsAcceptance({ termsAccepted: 'true' }, now), null);
  assert.equal(readTermsAcceptance(null, now), null);
});
