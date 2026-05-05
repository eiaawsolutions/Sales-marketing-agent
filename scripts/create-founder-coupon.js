#!/usr/bin/env node
/**
 * Create the FOUNDER_HQ Stripe coupon — 100% off, forever, all plans.
 * Idempotent: safe to re-run; fetches the existing coupon if it already exists.
 *
 * Run via: node scripts/create-founder-coupon.js
 * Requires: STRIPE_SECRET_KEY env, OR an active settings.stripe_secret_key row.
 */
import Stripe from 'stripe';
import db from '../src/db/index.js';
import { decrypt } from '../src/utils/crypto.js';

function getStripeKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
  const fromDb = row?.value ? decrypt(row.value) : '';
  return fromDb || process.env.STRIPE_SECRET_KEY || '';
}

const COUPON_ID = 'FOUNDER_HQ';

async function main() {
  const key = getStripeKey();
  if (!key) {
    console.error('No Stripe secret key. Set STRIPE_SECRET_KEY or settings.stripe_secret_key.');
    process.exit(1);
  }
  const stripe = new Stripe(key);

  // Check existing — idempotency.
  try {
    const existing = await stripe.coupons.retrieve(COUPON_ID);
    console.log('FOUNDER_HQ already exists:');
    console.log(JSON.stringify(existing, null, 2));
    return;
  } catch (e) {
    if (e.code !== 'resource_missing') throw e;
  }

  // Create. 100% off, applies forever (forever = no duration constraint).
  const coupon = await stripe.coupons.create({
    id: COUPON_ID,
    name: 'EIAAW Founder Comp',
    percent_off: 100,
    duration: 'forever',
    metadata: {
      purpose: 'founder',
      authorized_by: 'amos',
      created_at: new Date().toISOString(),
    },
  });

  console.log('Created coupon FOUNDER_HQ (100% off, forever):');
  console.log(JSON.stringify(coupon, null, 2));
  console.log('\nUse it at signup checkout: select your plan, then enter FOUNDER_HQ at the Stripe-hosted checkout page.');
  console.log('Stripe Checkout exposes "allow_promotion_codes" controls — verify the field is enabled in checkout.sessions.create().');
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
