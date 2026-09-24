/**
 * Env vars whose value MAY be an Infisical `secret://...` handle
 * (EIAAW Deploy Contract). src/bootstrap/secrets.js resolves them before the
 * app loads; everything else in env is passed through untouched.
 *
 * Handles use the house layout, flat at the workspace root:
 *   secret://eiaaw-all-projects/prod/<SECRET_NAME>
 * The Infisical name may differ from the env var name — e.g. ENCRYPTION_KEY
 * points at SALES_AGENT_ENCRYPTION_KEY because this key is the Sales Agent's
 * own (it decrypts settings already in the SQLite DB) and must never be
 * swapped for another service's similarly named key.
 *
 * Never list the INFISICAL_* bootstrap credentials here; they are needed to
 * reach Infisical in the first place.
 */

/** A 404 for any of these fails the boot: the app can't run correctly without them. */
export const REQUIRED_ENV_KEYS = [
  'ENCRYPTION_KEY',        // decrypts API keys / SMTP creds stored in settings
  'ANTHROPIC_API_KEY',     // chatbot + agent
  'STRIPE_SECRET_KEY',     // billing (falls back to the settings table when unset)
  'STRIPE_WEBHOOK_SECRET', // verifies Stripe webhooks
  'VOICE_REFRESH_TOKEN',   // guards the Retell prompt refresh endpoint
];

/** A 404 for any of these is logged and the var is dropped; the code has a fallback. */
export const OPTIONAL_ENV_KEYS = [
  'RESEND_API_KEY',  // email: falls back to SMTP
  'RESEND_WEBHOOK_SIGNING_SECRET', // delivery webhooks: rejected (503) when absent
  'SMTP_USER',
  'SMTP_PASS',
  'APOLLO_API_KEY',  // lead source: disabled when absent
  'TRACKING_SECRET',
  'PURGE_TOKEN',
  'FOUNDER_TOKEN',
];
