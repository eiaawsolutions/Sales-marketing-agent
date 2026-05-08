#!/usr/bin/env node
/** Diagnose Stripe key resolution. Read-only. */
import db from '../src/db/index.js';
import { decrypt } from '../src/utils/crypto.js';

const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
console.log('Row exists:', !!row);
if (row) {
  console.log('Raw value length:', row.value?.length || 0);
  console.log('Raw value starts with:', row.value?.slice(0, 8));
  console.log('Raw value starts with "enc:":', row.value?.startsWith('enc:'));
  try {
    const dec = decrypt(row.value);
    console.log('Decrypted length:', dec?.length || 0);
    console.log('Decrypted starts with:', dec?.slice(0, 8));
  } catch (e) {
    console.log('Decrypt error:', e.message);
  }
}
console.log('Env STRIPE_SECRET_KEY length:', (process.env.STRIPE_SECRET_KEY || '').length);

// Also check stripe_customer_1 / stripe_subscription_1
const cust = db.prepare("SELECT value FROM settings WHERE key = 'stripe_customer_1'").get();
const sub  = db.prepare("SELECT value FROM settings WHERE key = 'stripe_subscription_1'").get();
console.log('stripe_customer_1:', cust?.value || '(missing)');
console.log('stripe_subscription_1:', sub?.value || '(missing)');
