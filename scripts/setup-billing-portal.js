#!/usr/bin/env node
/**
 * Ensure the Stripe Customer Portal is enabled with self-serve subscription
 * cancellation, then cache the configuration id in settings so the
 * POST /api/billing/portal route reuses it.
 *
 * Run via: railway run node scripts/setup-billing-portal.js
 *
 * Idempotent: re-running reuses the cached config if it's still active, and
 * otherwise creates a fresh one. This mirrors ensurePortalConfig() in
 * src/routes/billing.js so the portal works on the very first user click
 * without depending on a manual Dashboard toggle.
 */
import Stripe from 'stripe';
import db from '../src/db/index.js';
import { decrypt } from '../src/utils/crypto.js';

function getStripeKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'stripe_secret_key'").get();
  const fromDb = row?.value ? decrypt(row.value) : '';
  return fromDb || process.env.STRIPE_SECRET_KEY || '';
}

// Base URL for the portal's privacy/terms links. Override with APP_BASE_URL.
const baseUrl = (process.env.APP_BASE_URL || 'https://sa.eiaawsolutions.com').replace(/\/$/, '');

async function main() {
  const key = getStripeKey();
  if (!key) {
    console.error('No Stripe secret key configured (settings.stripe_secret_key or STRIPE_SECRET_KEY).');
    process.exit(1);
  }
  const stripe = new Stripe(key);
  console.log(`Stripe mode: ${key.startsWith('sk_live') ? 'LIVE' : key.startsWith('sk_test') ? 'TEST' : 'unknown'}`);

  // Reuse the cached config if it still exists and is active.
  const cached = db.prepare("SELECT value FROM settings WHERE key = 'stripe_portal_config'").get()?.value;
  if (cached) {
    try {
      const existing = await stripe.billingPortal.configurations.retrieve(cached);
      if (existing && existing.active !== false) {
        console.log(`✓ Existing active portal config reused: ${existing.id}`);
        console.log(`  subscription_cancel.enabled = ${existing.features?.subscription_cancel?.enabled}`);
        return;
      }
      console.log(`Cached config ${cached} is archived/inactive — creating a new one.`);
    } catch (e) {
      console.log(`Cached config ${cached} not retrievable (${e.message}) — creating a new one.`);
    }
  }

  const config = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: 'EIAAW SalesAgent — manage your subscription',
      privacy_policy_url: `${baseUrl}/privacy.html`,
      terms_of_service_url: `${baseUrl}/terms.html`,
    },
    features: {
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other'],
        },
      },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
  });

  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
    .run('stripe_portal_config', config.id);

  console.log(`\n✓ Created portal config: ${config.id}`);
  console.log(`  subscription_cancel.enabled = ${config.features?.subscription_cancel?.enabled} (mode: ${config.features?.subscription_cancel?.mode})`);
  console.log(`  payment_method_update.enabled = ${config.features?.payment_method_update?.enabled}`);
  console.log(`  invoice_history.enabled = ${config.features?.invoice_history?.enabled}`);
  console.log(`  cached in settings.stripe_portal_config`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
