// lead_sources — a connection the user created. The unit the Sources page lists.
//
// The ingest_key in the URL is the tenant routing decision. Whoever holds it
// writes leads into exactly one user's funnel and no other. That replaces the
// LEAD_OWNER_MAP env var in routes/forms.js, which hardcoded every public
// intake to FOUNDER_ID = 1 and therefore dumped every site's chatbot leads into
// the HQ account regardless of who owned the site.

import crypto from 'crypto';
import db from '../db/index.js';
import { encrypt, decrypt } from '../utils/crypto.js';

// Connectors reachable over HTTP at /api/ingest/:ingestKey.
// `gated` ones need platform app review before a real customer's leads can
// flow, so they are not offered yet — listed here so the UI can say "coming".
export const SOURCE_TYPES = {
  webhook: { label: 'Custom Webhook', authMode: 'hmac', inbound: true, description: 'Sign requests with HMAC-SHA256. For your own backend or any tool that can compute a signature.' },
  zapier: { label: 'Zapier / Make / n8n', authMode: 'token', inbound: true, description: 'A shared bearer token in the X-Ingest-Token header. Reaches every app those platforms support.' },
  google_ads: { label: 'Google Ads Lead Form', authMode: 'provider', inbound: true, description: 'Paste the webhook URL and key into your Google Ads lead form extension. No app review needed.' },
  calendly: { label: 'Calendly / Cal.com', authMode: 'provider', inbound: true, description: 'A booked meeting becomes a lead and an appointment.' },
  email_inbound: { label: 'Inbound Email', authMode: 'provider', inbound: true, description: 'Forward an address to Resend. Replies become leads.' },
  web_form: { label: 'Web Form', authMode: 'public', inbound: true, description: 'A form you embed on your site. The key is visible in page source, so submissions are rate limited.' },
  chatbot: { label: 'Website Chatbot', authMode: 'public', inbound: true, description: 'The pre-chat gate on your site captures name, email, and phone.' },

  // Server-side only. Never reachable over HTTP.
  voice: { label: 'Voice Agent', authMode: 'internal', inbound: false, description: 'Call links and voice AI sessions.' },
  csv: { label: 'CSV Import', authMode: 'internal', inbound: false, description: 'Bulk upload.' },
  manual: { label: 'Manual Entry', authMode: 'internal', inbound: false, description: 'Leads you type in yourself.' },
  apollo: { label: 'Apollo.io', authMode: 'internal', inbound: false, description: 'Outbound sourcing with verified emails.' },
  ai_websearch: { label: 'AI Web Search', authMode: 'internal', inbound: false, description: 'Claude browses the open web and cites its sources.' },
};

// Needs Meta / LinkedIn / TikTok app review + business verification before any
// real customer's leads can flow. Documented, not offered.
export const GATED_SOURCE_TYPES = [
  { type: 'meta_lead_ads', label: 'Meta Lead Ads', blocker: 'Requires leads_retrieval Advanced Access + Meta business verification' },
  { type: 'linkedin_lead_gen', label: 'LinkedIn Lead Gen Forms', blocker: 'Requires LinkedIn Lead Sync API program approval' },
  { type: 'tiktok_lead_gen', label: 'TikTok Lead Generation', blocker: 'Requires TikTok for Business API access approval' },
];

// The `internal` sources every tenant needs so that server-side lead paths have
// a source_id to attribute against. Created lazily.
//
// `web_form` and `chatbot` appear here AND in SOURCE_TYPES as public inbound
// types — deliberately. The built-in Forms feature and the first-party site
// chatbot are server-side and trusted (the tenant authored them in-app), so
// they attribute to an INTERNAL source. A tenant embedding a form on their own
// external site and POSTing to /api/ingest/:key instead creates a PUBLIC
// web_form/chatbot source. The two coexist and are told apart by auth_mode.
const INTERNAL_TYPES = ['manual', 'csv', 'apollo', 'ai_websearch', 'voice', 'web_form', 'chatbot'];

function newIngestKey(type) {
  // Prefix aids debugging in logs without revealing the secret. 32 bytes of
  // entropy: this key IS the tenant routing decision, so it must be unguessable.
  return `${type.slice(0, 4)}_${crypto.randomBytes(24).toString('base64url')}`;
}

function newSecret() {
  return crypto.randomBytes(32).toString('hex');
}

export const leadSourcesService = {
  getAll(userId, { includeInternal = true } = {}) {
    const rows = db.prepare(
      'SELECT * FROM lead_sources WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
    const filtered = includeInternal ? rows : rows.filter(r => r.auth_mode !== 'internal');
    return filtered.map(publicView);
  },

  getById(userId, id) {
    const row = db.prepare('SELECT * FROM lead_sources WHERE id = ? AND user_id = ?').get(id, userId);
    return row ? publicView(row) : null;
  },

  // Used by the ingest route. Returns the RAW row (with secret_enc) — never
  // hand this to a response body.
  getByIngestKey(ingestKey) {
    if (typeof ingestKey !== 'string' || ingestKey.length < 8 || ingestKey.length > 128) return null;
    return db.prepare('SELECT * FROM lead_sources WHERE ingest_key = ?').get(ingestKey) || null;
  },

  decryptSecret(row) {
    return row?.secret_enc ? decrypt(row.secret_enc) : null;
  },

  create(userId, input) {
    const type = String(input.type || '');
    const meta = SOURCE_TYPES[type];
    if (!meta) throw new Error(`Unknown source type: ${type}`);
    if (meta.authMode === 'internal' && !input._allowInternal) {
      throw new Error(`"${meta.label}" is managed automatically and cannot be created by hand.`);
    }

    const name = String(input.name || meta.label).trim().slice(0, 120) || meta.label;

    // For 'zapier' the caller may prefer HMAC; everything else uses the type's
    // documented mode. Never let the client pick 'internal'.
    let authMode = meta.authMode;
    if (type === 'zapier' && input.auth_mode === 'hmac') authMode = 'hmac';
    if (authMode === 'internal' && !input._allowInternal) authMode = 'public';

    const needsSecret = authMode === 'hmac' || authMode === 'token' || authMode === 'provider';
    const secret = needsSecret ? (String(input.secret || '').trim() || newSecret()) : null;

    // auto_promote: skip the inbox when the score clears the tenant threshold.
    // Internal sources (you typed it in / you uploaded it) are trusted by
    // definition. Everything else defaults to whatever the caller asked for.
    const autoPromote = meta.authMode === 'internal' ? 1 : (input.auto_promote ? 1 : 0);

    const res = db.prepare(`
      INSERT INTO lead_sources (user_id, type, name, ingest_key, secret_enc, auth_mode, config, auto_promote)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, type, name, newIngestKey(type),
      secret ? encrypt(secret) : null,
      authMode,
      JSON.stringify(input.config && typeof input.config === 'object' ? input.config : {}),
      autoPromote
    );

    const created = this.getById(userId, res.lastInsertRowid);
    // The plaintext secret is returned exactly once, at creation. After this it
    // only exists encrypted at rest; a user who loses it must rotate.
    return { ...created, secret };
  },

  update(userId, id, input) {
    const existing = db.prepare('SELECT * FROM lead_sources WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return null;

    const fields = [];
    const params = [];
    if (typeof input.name === 'string' && input.name.trim()) {
      fields.push('name = ?'); params.push(input.name.trim().slice(0, 120));
    }
    if (['active', 'paused', 'disabled'].includes(input.status)) {
      fields.push('status = ?'); params.push(input.status);
    }
    if (input.auto_promote !== undefined) {
      fields.push('auto_promote = ?'); params.push(input.auto_promote ? 1 : 0);
    }
    if (input.config && typeof input.config === 'object') {
      fields.push('config = ?'); params.push(JSON.stringify(input.config));
    }
    // The provider modes carry a secret the PROVIDER generates (Google's
    // google_key, Calendly's signing key, Resend's whsec_). Let the user paste it.
    if (typeof input.secret === 'string' && input.secret.trim()) {
      fields.push('secret_enc = ?'); params.push(encrypt(input.secret.trim()));
    }
    if (!fields.length) return this.getById(userId, id);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id, userId);
    db.prepare(`UPDATE lead_sources SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
    return this.getById(userId, id);
  },

  rotateSecret(userId, id) {
    const existing = db.prepare('SELECT * FROM lead_sources WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return null;
    if (!['hmac', 'token', 'provider'].includes(existing.auth_mode)) {
      throw new Error('This source type has no secret to rotate.');
    }
    const secret = newSecret();
    db.prepare('UPDATE lead_sources SET secret_enc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(encrypt(secret), id);
    return { ...this.getById(userId, id), secret };
  },

  rotateIngestKey(userId, id) {
    const existing = db.prepare('SELECT * FROM lead_sources WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return null;
    db.prepare('UPDATE lead_sources SET ingest_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newIngestKey(existing.type), id);
    return this.getById(userId, id);
  },

  delete(userId, id) {
    const existing = db.prepare('SELECT auth_mode FROM lead_sources WHERE id = ? AND user_id = ?').get(id, userId);
    if (!existing) return false;
    if (existing.auth_mode === 'internal') {
      throw new Error('Built-in sources cannot be deleted. Pause them instead.');
    }
    // ON DELETE CASCADE clears lead_inbox rows. leads.last_source_id becomes a
    // dangling FK value, so null it out first rather than orphan the reference.
    const run = db.transaction(() => {
      db.prepare('UPDATE leads SET last_source_id = NULL WHERE last_source_id = ? AND user_id = ?').run(id, userId);
      db.prepare('UPDATE leads SET first_source_id = NULL WHERE first_source_id = ? AND user_id = ?').run(id, userId);
      db.prepare('UPDATE leads SET source_id = NULL WHERE source_id = ? AND user_id = ?').run(id, userId);
      db.prepare('UPDATE lead_touchpoints SET source_id = NULL WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM lead_sources WHERE id = ? AND user_id = ?').run(id, userId);
    });
    run();
    return true;
  },

  // Lazily create (and return) the internal source a server-side path attributes
  // against. Idempotent: one row per (user, type).
  //
  // Returns null rather than throwing when the row cannot be created — e.g. the
  // FK fails because `userId` names a user that no longer exists. Attribution is
  // a nice-to-have; losing it must never take down lead generation. Every
  // *_source_id column is nullable precisely so this can degrade.
  ensureInternal(userId, type) {
    if (!INTERNAL_TYPES.includes(type)) throw new Error(`"${type}" is not an internal source type`);
    const read = () => db.prepare(
      'SELECT * FROM lead_sources WHERE user_id = ? AND type = ? AND auth_mode = ?'
    ).get(userId, type, 'internal');

    const found = read();
    if (found) return found;

    const meta = SOURCE_TYPES[type];
    try {
      const res = db.prepare(`
        INSERT INTO lead_sources (user_id, type, name, ingest_key, auth_mode, auto_promote, status)
        VALUES (?, ?, ?, ?, 'internal', 1, 'active')
      `).run(userId, type, meta.label, newIngestKey(type));
      return db.prepare('SELECT * FROM lead_sources WHERE id = ?').get(res.lastInsertRowid);
    } catch (e) {
      const raced = read(); // concurrent create
      if (raced) return raced;
      console.error(`[lead-sources] could not create internal "${type}" source for user ${userId}: ${e.message}`);
      return null;
    }
  },

  // Convenience for call sites that only need the id and can tolerate null.
  internalSourceId(userId, type) {
    return this.ensureInternal(userId, type)?.id ?? null;
  },

  recordEvent(sourceId, outcome, errorMessage = null) {
    const col = {
      received: 'received_count', accepted: 'accepted_count',
      rejected: 'rejected_count', duplicate: 'duplicate_count',
    }[outcome];
    if (!col) return;
    const health = outcome === 'rejected' && errorMessage ? 'error' : 'ok';
    db.prepare(`
      UPDATE lead_sources
         SET ${col} = ${col} + 1,
             last_event_at = CURRENT_TIMESTAMP,
             health = ?,
             last_error = ?
       WHERE id = ?
    `).run(health, errorMessage ? String(errorMessage).slice(0, 500) : null, sourceId);
  },

  // Per-source funnel: how many arrived, how many became leads, how many
  // reached a deal, how many closed won. This is the number the Sources page
  // exists to show — "which channel actually produces revenue".
  funnel(userId) {
    return db.prepare(`
      SELECT
        s.id, s.name, s.type, s.status, s.health, s.last_event_at,
        s.received_count, s.accepted_count, s.rejected_count, s.duplicate_count,
        (SELECT COUNT(*) FROM lead_inbox i WHERE i.source_id = s.id AND i.status = 'pending') AS pending_count,
        (SELECT COUNT(*) FROM leads l WHERE l.first_source_id = s.id) AS leads_count,
        (SELECT COUNT(*) FROM leads l WHERE l.first_source_id = s.id AND l.status = 'qualified') AS qualified_count,
        (SELECT COUNT(*) FROM pipeline p JOIN leads l ON l.id = p.lead_id WHERE l.first_source_id = s.id) AS deals_count,
        (SELECT COALESCE(SUM(p.deal_value), 0) FROM pipeline p JOIN leads l ON l.id = p.lead_id
          WHERE l.first_source_id = s.id AND p.stage = 'closed_won') AS won_value
      FROM lead_sources s
      WHERE s.user_id = ?
      ORDER BY leads_count DESC, s.created_at DESC
    `).all(userId);
  },
};

// Never expose secret_enc. `has_secret` is enough for the UI to render state.
function publicView(row) {
  const { secret_enc, ...rest } = row;
  return {
    ...rest,
    has_secret: !!secret_enc,
    config: safeParse(row.config),
    label: SOURCE_TYPES[row.type]?.label || row.type,
    inbound: !!SOURCE_TYPES[row.type]?.inbound,
  };
}

function safeParse(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}
