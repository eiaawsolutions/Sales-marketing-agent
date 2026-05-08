#!/usr/bin/env node
/**
 * Attach FOUNDER_HQ coupon to a user's Stripe subscription so every
 * recurring invoice (after the trial) is RM 0.00 forever.
 *
 * Run via: railway run node scripts/apply-founder-coupon.js <email>
 *
 * Idempotent: safe to re-run; Stripe replaces the discount on the
 * subscription cleanly.
 */
import Stripe from 'stripe';
import db from '../src/db/index.js';
import { decrypt } from '../src/utils/crypto.js';

const email = (process.argv[2] || '').toLowerCase().trim();
if (!email) {
  console.error('Usage: node scripts/apply-founder-coupon.js <email>');
  process.exit(1);
}

const COUPON_ID = 'FOUNDER_HQ';

function getStripeKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
  const fromDb = row?.value ? decrypt(row.value) : '';
  return fromDb || process.env.STRIPE_SECRET_KEY || '';
}

async function main() {
  const key = getStripeKey();
  if (!key) {
    console.error('No Stripe secret key configured.');
    process.exit(1);
  }
  const stripe = new Stripe(key);

  const user = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(email);
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }

  // Subscription ID is stored in settings keyed by user id.
  const subRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(`stripe_subscription_${user.id}`);
  const subId = subRow?.value;
  if (!subId) {
    console.error(`No stripe_subscription_${user.id} in settings. The user has no Stripe subscription record on file.`);
    process.exit(1);
  }

  console.log(`User: ${user.email} (id=${user.id})`);
  console.log(`Subscription: ${subId}`);

  // Confirm coupon exists.
  try {
    const coupon = await stripe.coupons.retrieve(COUPON_ID);
    console.log(`Coupon ${COUPON_ID}: ${coupon.percent_off}% off, duration=${coupon.duration}, valid=${coupon.valid}`);
  } catch (e) {
    console.error(`Coupon ${COUPON_ID} not found on Stripe: ${e.message}`);
    process.exit(1);
  }

  // Attach the coupon to the subscription so every recurring invoice
  // is discounted 100% forever.
  const before = await stripe.subscriptions.retrieve(subId);
  const beforeDiscount = before.discount?.coupon?.id || '(none)';
  console.log(`Before: discount = ${beforeDiscount}`);

  const updated = await stripe.subscriptions.update(subId, { coupon: COUPON_ID });
  const afterDiscount = updated.discount?.coupon?.id || '(none)';
  console.log(`After: discount = ${afterDiscount}`);

  if (afterDiscount === COUPON_ID) {
    console.log(`\n✓ ${COUPON_ID} attached to subscription. Every recurring invoice for ${user.email} will be RM 0.00 after the trial ends.`);
  } else {
    console.error(`\n✗ Discount did NOT attach. Got: ${afterDiscount}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
