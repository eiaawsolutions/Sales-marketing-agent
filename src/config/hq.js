// Single source of truth for the HQ / Founder identity.
//
// TWO invariants hang off this one email:
//   1. Only this account may hold the `superadmin` role (enforced on every
//      write path: PUT /api/users/:id, promote-founder.js, and a self-healing
//      demotion on DB init in schema.js).
//   2. Only this account is the business-tier Founder comp — RM 0.00 via the
//      FOUNDER_HQ Stripe coupon (see routes/billing.js /usage + the webhook
//      never-suspend guard).
//
// Overridable via env for staging / re-branding; defaults to the production HQ.
export const FOUNDER_HQ_EMAIL = (process.env.FOUNDER_HQ_EMAIL || 'eiaawsolutions@gmail.com').trim().toLowerCase();

// Case-insensitive, whitespace-tolerant match. Null/empty is never HQ.
export function isFounderHq(email) {
  return !!email && String(email).trim().toLowerCase() === FOUNDER_HQ_EMAIL;
}
