// POST /api/ingest/:ingestKey — the public, unauthenticated lead intake.
//
// This is the only route in the app that accepts a lead from the open internet
// on behalf of a tenant it has never authenticated. Everything below exists to
// make that safe:
//
//   * server.js mounts express.raw() on /api/ingest BEFORE express.json(), so
//     req.body is a Buffer and signatures are checked against the exact bytes
//     the sender signed. (JSON.parse → JSON.stringify does not round-trip.)
//   * The ingest_key selects the tenant. It never comes from the payload, so a
//     caller cannot address another tenant's funnel.
//   * Rate limiting is keyed on the ingest_key, not the IP: Google and Calendly
//     call from large, rotating IP ranges, and one noisy tenant must not consume
//     another tenant's budget.
//   * Error responses are deliberately uninformative. "bad signature" vs "stale
//     timestamp" vs "no such key" are all 401/404 with a fixed body. The detail
//     goes to our logs and to lead_sources.last_error, which only the owner sees.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { leadSourcesService } from '../services/lead-sources.js';
import { ingest, IngestRejected } from '../services/lead-ingest.js';
import { adapterFor, isLeadBearingEvent } from '../services/source-adapters.js';
import {
  verifyIngestRequest, verifyCalendly, verifyCalDotCom, verifySvix, verifyGoogleAds,
} from '../services/ingest-auth.js';

const router = Router();

const MAX_BODY_BYTES = 512 * 1024;

// Per-key limits. A public embed key is visible in page source, so it gets the
// tightest budget; a signed webhook can be trusted with more.
const PUBLIC_LIMIT = 20;   // per minute
const SIGNED_LIMIT = 240;  // per minute

const ingestLimiter = rateLimit({
  windowMs: 60_000,
  validate: false,
  keyGenerator: (req) => `ingest:${req.params.ingestKey || req.ip}`,
  max: (req) => (req._ingestSource?.auth_mode === 'public' ? PUBLIC_LIMIT : SIGNED_LIMIT),
  message: { error: 'Rate limit exceeded.' },
});

// Resolve the source before the limiter runs so `max` can read its auth_mode.
// A bad key still burns a slot in the fallback IP bucket below, so key guessing
// is not free.
const keyGuessLimiter = rateLimit({
  windowMs: 60_000, max: 30, validate: false,
  keyGenerator: (req) => `ingest_badkey:${req.ip}`,
  message: { error: 'Rate limit exceeded.' },
});

function loadSource(req, res, next) {
  const source = leadSourcesService.getByIngestKey(req.params.ingestKey);
  if (!source || source.auth_mode === 'internal') {
    // Same shape and status whether the key is unknown, malformed, or names an
    // internal source. No oracle for enumerating valid keys.
    return keyGuessLimiter(req, res, () => res.status(404).json({ error: 'Not found' }));
  }
  req._ingestSource = source;
  next();
}

function parseBody(raw) {
  if (!Buffer.isBuffer(raw)) return { ok: false };
  if (raw.length === 0) return { ok: true, body: {} };
  if (raw.length > MAX_BODY_BYTES) return { ok: false, tooLarge: true };
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, body: parsed };
  } catch {
    return { ok: false };
  }
}

function verify(source, secret, rawBody, body, headers) {
  if (source.auth_mode !== 'provider') {
    return verifyIngestRequest(source, secret, rawBody, headers);
  }
  if (!secret) return { ok: false, status: 500, reason: 'provider source has no secret' };

  switch (source.type) {
    case 'google_ads':
      return verifyGoogleAds(secret, body);
    case 'calendly':
      // Cal.com and Calendly are one source type with two signature schemes.
      // Whichever header is present decides.
      if (headers['x-cal-signature-256']) return verifyCalDotCom(secret, rawBody, headers);
      return verifyCalendly(secret, rawBody, headers);
    case 'email_inbound':
      return verifySvix(secret, rawBody, headers);
    default:
      return { ok: false, status: 400, reason: `no provider verifier for ${source.type}` };
  }
}

router.post('/:ingestKey', loadSource, ingestLimiter, (req, res) => {
  const source = req._ingestSource;

  const parsed = parseBody(req.body);
  if (!parsed.ok) {
    const reason = parsed.tooLarge ? 'payload too large' : 'invalid JSON body';
    leadSourcesService.recordEvent(source.id, 'rejected', reason);
    return res.status(parsed.tooLarge ? 413 : 400).json({ error: 'Invalid request' });
  }
  const body = parsed.body;

  const secret = leadSourcesService.decryptSecret(source);
  const auth = verify(source, secret, req.body, body, req.headers);
  if (!auth.ok) {
    // Log the real reason for the owner; tell the caller nothing.
    console.warn(`[ingest] source ${source.id} (${source.type}) rejected: ${auth.reason}`);
    leadSourcesService.recordEvent(source.id, 'rejected', auth.reason);
    const status = auth.status === 500 ? 500 : (auth.status === 403 ? 403 : 401);
    return res.status(status).json({ error: status === 500 ? 'Source misconfigured' : 'Unauthorized' });
  }

  // Providers fan out every event type to one endpoint. Acknowledge the ones we
  // do not act on — a 4xx here makes them retry, then disable the webhook.
  if (!isLeadBearingEvent(source.type, body)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const adapter = adapterFor(source.type);
  if (!adapter) {
    return res.status(500).json({ error: 'Source misconfigured' });
  }

  let payload;
  try {
    payload = adapter.normalize(body, source);
  } catch (e) {
    console.error(`[ingest] adapter ${source.type} threw:`, e.message);
    leadSourcesService.recordEvent(source.id, 'rejected', `adapter error: ${e.message}`);
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    const result = ingest(source, payload, {
      externalId: adapter.externalId(body),
      raw: body,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
    });

    // 202: we have durably accepted it. Qualification may still be queued.
    // Providers only care that this is a 2xx.
    return res.status(202).json({
      ok: true,
      status: result.status,
      ...(result.status === 'duplicate' ? { duplicate: true } : {}),
    });
  } catch (e) {
    if (e instanceof IngestRejected) {
      // A well-formed request carrying an unusable lead. 200, not 4xx — the
      // sender did nothing wrong at the protocol level and must not retry.
      return res.status(200).json({ ok: true, status: 'rejected', reason: e.reason });
    }
    console.error(`[ingest] source ${source.id} failed:`, e);
    leadSourcesService.recordEvent(source.id, 'rejected', e.message);
    return res.status(500).json({ error: 'Ingest failed' });
  }
});

// GET is how Google Ads and some tools "test" a webhook URL, and how a human
// checks they pasted the right thing. Reveals nothing about the source.
router.get('/:ingestKey', loadSource, (req, res) => {
  res.json({ ok: true, ready: true, method: 'POST' });
});

export default router;
