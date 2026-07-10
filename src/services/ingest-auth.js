// Signature verification for the public lead-ingest endpoint.
//
// Everything here operates on the RAW request body (a Buffer). Once
// express.json() has parsed and re-serialized a payload, key order and unicode
// escaping may differ from what the sender signed, so any HMAC computed over
// JSON.stringify(req.body) is a coin flip. server.js mounts express.raw() on
// /api/ingest BEFORE express.json(), mirroring the existing Stripe webhook.
//
// Timing-safe comparison everywhere. A non-constant-time compare on a signature
// leaks it one byte at a time to a patient attacker.

import crypto from 'crypto';

// Reject anything signed more than this long ago. Bounds the window in which a
// captured request can be replayed before the idempotency index would catch it.
export const REPLAY_WINDOW_SECONDS = 300;

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Buffer.from(..., 'hex') silently truncates on odd/invalid input, which would
  // make two different signatures compare equal. Validate shape first.
  if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Unequal lengths cannot be compared by timingSafeEqual and already reveal a
  // mismatch through the length itself, which is not secret.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function signPayload(secret, rawBody, timestamp) {
  const mac = crypto.createHmac('sha256', secret);
  mac.update(`${timestamp}.`);
  mac.update(rawBody);
  return mac.digest('hex');
}

// Header format, deliberately the same shape Stripe and Calendly use:
//   X-EIAAW-Signature: t=1750000000,v1=<hex sha256>
function parseSignatureHeader(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k && v && !(k in out)) out[k] = v; // first wins; ignore duplicate keys
  }
  return out;
}

// ---------------------------------------------------------------------------
// verifyIngestRequest(source, secret, rawBody, headers, now)
//   → { ok: true } | { ok: false, status, reason }
//
// `reason` is for OUR logs. The HTTP response must never echo it — telling a
// caller "bad timestamp" vs "bad signature" is a free oracle.
// ---------------------------------------------------------------------------
export function verifyIngestRequest(source, secret, rawBody, headers, now = Date.now()) {
  const mode = source.auth_mode;

  if (source.status !== 'active') {
    return { ok: false, status: 403, reason: `source is ${source.status}` };
  }

  if (mode === 'internal') {
    // Structurally unreachable: routes/ingest.js filters these out before we get
    // here. Defence in depth in case a future route forgets.
    return { ok: false, status: 404, reason: 'internal source is not HTTP-reachable' };
  }

  if (mode === 'public') {
    // The ingest_key is embedded in client-side JS, so it is an identifier, not
    // a credential. The route applies a tight rate limit and these sources are
    // pinned to auto_promote = 0, so anything they produce waits in the inbox
    // for a human. Nothing to verify here.
    return { ok: true };
  }

  if (mode === 'token') {
    const presented = headers['x-ingest-token'];
    if (!secret) return { ok: false, status: 500, reason: 'source has no secret configured' };
    if (!presented) return { ok: false, status: 401, reason: 'missing X-Ingest-Token' };
    if (!timingSafeEqualStr(String(presented), secret)) {
      return { ok: false, status: 401, reason: 'token mismatch' };
    }
    return { ok: true };
  }

  if (mode === 'hmac') {
    if (!secret) return { ok: false, status: 500, reason: 'source has no secret configured' };
    const parsed = parseSignatureHeader(headers['x-eiaaw-signature']);
    const t = parsed.t;
    const v1 = parsed.v1;
    if (!t || !v1) return { ok: false, status: 401, reason: 'missing or malformed X-EIAAW-Signature' };

    const ts = Number(t);
    if (!Number.isInteger(ts)) return { ok: false, status: 401, reason: 'non-integer timestamp' };

    const skew = Math.abs(Math.floor(now / 1000) - ts);
    if (skew > REPLAY_WINDOW_SECONDS) {
      return { ok: false, status: 401, reason: `timestamp outside replay window (${skew}s)` };
    }

    const expected = signPayload(secret, rawBody, t);
    if (!timingSafeEqualHex(expected, v1)) {
      return { ok: false, status: 401, reason: 'signature mismatch' };
    }
    return { ok: true };
  }

  if (mode === 'provider') {
    // Delegated to the per-provider adapter, which knows that provider's header
    // and digest scheme. routes/ingest.js calls verifyProvider() instead.
    return { ok: false, status: 500, reason: 'provider mode must be verified by its adapter' };
  }

  return { ok: false, status: 400, reason: `unknown auth_mode: ${mode}` };
}

// ---------------------------------------------------------------------------
// Provider-specific verification.
// ---------------------------------------------------------------------------

// Calendly: `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over
// "<t>.<rawBody>". Same construction as ours, different header name.
export function verifyCalendly(secret, rawBody, headers, now = Date.now()) {
  const parsed = parseSignatureHeader(headers['calendly-webhook-signature']);
  if (!parsed.t || !parsed.v1) return { ok: false, status: 401, reason: 'missing Calendly signature' };
  const ts = Number(parsed.t);
  if (!Number.isInteger(ts)) return { ok: false, status: 401, reason: 'non-integer timestamp' };
  if (Math.abs(Math.floor(now / 1000) - ts) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, status: 401, reason: 'timestamp outside replay window' };
  }
  if (!timingSafeEqualHex(signPayload(secret, rawBody, parsed.t), parsed.v1)) {
    return { ok: false, status: 401, reason: 'signature mismatch' };
  }
  return { ok: true };
}

// Cal.com: `X-Cal-Signature-256: <hex>`, plain HMAC-SHA256 of the raw body with
// no timestamp. There is nothing to bound replay with, so we lean entirely on
// the idempotency index over the event id.
export function verifyCalDotCom(secret, rawBody, headers) {
  const presented = headers['x-cal-signature-256'];
  if (!presented) return { ok: false, status: 401, reason: 'missing X-Cal-Signature-256' };
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!timingSafeEqualHex(expected, String(presented))) {
    return { ok: false, status: 401, reason: 'signature mismatch' };
  }
  return { ok: true };
}

// Svix (used by Resend inbound email):
//   svix-id, svix-timestamp, svix-signature: "v1,<base64> v1,<base64> ..."
//   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
//   secret arrives as "whsec_<base64>"; the bytes are the base64 part decoded.
// Multiple space-separated signatures may be present during secret rotation —
// any one matching is a pass.
export function verifySvix(secret, rawBody, headers, now = Date.now()) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!id || !ts || !sigHeader) return { ok: false, status: 401, reason: 'missing svix headers' };

  const tsNum = Number(ts);
  if (!Number.isInteger(tsNum)) return { ok: false, status: 401, reason: 'non-integer svix-timestamp' };
  if (Math.abs(Math.floor(now / 1000) - tsNum) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, status: 401, reason: 'svix timestamp outside replay window' };
  }

  const keyB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key;
  try { key = Buffer.from(keyB64, 'base64'); } catch { return { ok: false, status: 500, reason: 'bad svix secret' }; }
  if (!key.length) return { ok: false, status: 500, reason: 'empty svix secret' };

  const mac = crypto.createHmac('sha256', key);
  mac.update(`${id}.${ts}.`);
  mac.update(rawBody);
  const expected = mac.digest(); // Buffer

  for (const part of String(sigHeader).split(' ')) {
    const [version, b64] = part.split(',');
    if (version !== 'v1' || !b64) continue;
    let presented;
    try { presented = Buffer.from(b64, 'base64'); } catch { continue; }
    if (presented.length === expected.length && crypto.timingSafeEqual(presented, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, status: 401, reason: 'no matching svix signature' };
}

// Google Ads Lead Form: no signature header. Google posts a JSON body carrying
// a `google_key` field that must equal the secret configured on the lead form.
// This is a bearer secret in the body, so it must be compared timing-safely and
// the endpoint must be rate limited. Google documents no replay protection;
// idempotency comes from `lead_id` in the payload.
export function verifyGoogleAds(secret, parsedBody) {
  const presented = parsedBody && typeof parsedBody === 'object' ? parsedBody.google_key : undefined;
  if (typeof presented !== 'string' || !presented) {
    return { ok: false, status: 401, reason: 'missing google_key' };
  }
  if (!timingSafeEqualStr(presented, secret)) {
    return { ok: false, status: 401, reason: 'google_key mismatch' };
  }
  return { ok: true };
}

export const __testing = { parseSignatureHeader, timingSafeEqualHex, timingSafeEqualStr };
