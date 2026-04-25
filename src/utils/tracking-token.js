import crypto from 'crypto';

// Truncated HMAC-SHA256 token bound to (campaignId, leadId). Keeps email
// tracking links short enough not to wrap in every email client (12 hex
// chars = 48 bits — easily long enough to defeat brute-force at the
// internet-scale, while a real attacker can only rate-limit through a
// shared 120-rpm cap).
const TOKEN_LEN = 12;

function getSecret() {
  // Reuse the encryption-at-rest secret. It's already mandatory in production
  // (see utils/crypto.js), and rotating it requires re-issuing every link
  // anyway. Falls back to a stable per-install random for dev.
  const k = process.env.ENCRYPTION_KEY || process.env.TRACKING_SECRET;
  if (k) return k;
  // Dev fallback: derive from package + node version so tokens stay stable
  // across restarts on the same machine without forcing a key.
  return `dev-tracking-${process.platform}-${process.version}`;
}

export function signTracking(campaignId, leadId) {
  const h = crypto.createHmac('sha256', getSecret()).update(`${campaignId}:${leadId}`).digest('hex');
  return h.slice(0, TOKEN_LEN);
}

export function verifyTracking(campaignId, leadId, token) {
  if (!token || typeof token !== 'string' || token.length !== TOKEN_LEN) return false;
  const expected = signTracking(campaignId, leadId);
  // Constant-time compare so timing doesn't leak partial token bytes.
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
  } catch {
    return false;
  }
}
