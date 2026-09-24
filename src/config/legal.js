// Versions of the published legal documents. Checkout stamps these onto the
// Stripe session so every subscription carries evidence of which Terms and
// privacy notice the buyer accepted (Electronic Commerce Act 2006 s.7).
//
// Bump them in the same commit that changes public/terms.html or
// public/privacy.html, and archive the superseded page under
// public/legal/archive/ first. tests/legal-pages.test.js fails if the
// numbers here and the "Version" shown on the pages drift apart.
export const TERMS_VERSION = '2.0';
export const PRIVACY_VERSION = '2.1';
export const DPA_VERSION = '1.0';
export const LEGAL_EFFECTIVE_DATE = '2026-09-25';

// Returns the acceptance record for a checkout request, or null when the buyer
// did not accept. The landing and proposal signup forms send
// { termsAccepted: true, termsAcceptedAt: <client ISO time> } after the box is
// ticked; older cached copies of the landing page send termsAcceptedAt only, so
// a parseable termsAcceptedAt is also accepted as the tick. The recorded time is
// the server's clock, not the client's, and the recorded versions are the ones
// being served now.
export function readTermsAcceptance(body, now = new Date()) {
  const b = body || {};
  const ticked = b.termsAccepted === true
    || (typeof b.termsAcceptedAt === 'string' && b.termsAcceptedAt.trim() !== '' && !Number.isNaN(Date.parse(b.termsAcceptedAt)));
  if (!ticked) return null;
  return {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    acceptedAt: now.toISOString(),
  };
}
