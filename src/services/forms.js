import db from '../db/index.js';

// Allowed field types — keep in sync with frontend builder + public renderer.
// Each field has { id, type, label, name, required, placeholder?, options?[] }
const ALLOWED_FIELD_TYPES = new Set([
  'name', 'email', 'phone', 'text', 'textarea', 'dropdown', 'calendar', 'social_links',
]);

function parseFields(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr.filter(f => f && ALLOWED_FIELD_TYPES.has(f.type));
  } catch {
    return [];
  }
}

function serializeFields(fields) {
  if (!Array.isArray(fields)) return '[]';
  const clean = fields
    .filter(f => f && ALLOWED_FIELD_TYPES.has(f.type))
    .map((f, i) => ({
      id: String(f.id || `f${i}`),
      type: f.type,
      label: String(f.label || '').slice(0, 120),
      name: String(f.name || f.id || `field_${i}`).replace(/[^a-z0-9_]/gi, '_').slice(0, 60),
      required: !!f.required,
      placeholder: String(f.placeholder || '').slice(0, 200),
      options: Array.isArray(f.options) ? f.options.map(o => String(o).slice(0, 100)).slice(0, 30) : undefined,
    }));
  return JSON.stringify(clean);
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, fields: parseFields(row.fields) };
}

export const formsService = {
  getAll(userId) {
    const rows = userId
      ? db.prepare('SELECT * FROM forms WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
      : db.prepare('SELECT * FROM forms ORDER BY updated_at DESC').all();
    return rows.map(hydrate);
  },

  getById(userId, id) {
    const row = userId
      ? db.prepare('SELECT * FROM forms WHERE id = ? AND user_id = ?').get(id, userId)
      : db.prepare('SELECT * FROM forms WHERE id = ?').get(id);
    return hydrate(row);
  },

  // Public fetch — no user scoping (used by /forms/public/:id for recipients).
  getPublic(id) {
    const row = db.prepare('SELECT id, user_id, name, title, description, header_html, footer_html, logo_url, button_text, redirect_url, fields FROM forms WHERE id = ?').get(id);
    return hydrate(row);
  },

  create(userId, data) {
    const fields = serializeFields(data.fields);
    const result = db.prepare(`
      INSERT INTO forms (user_id, name, title, description, header_html, footer_html, logo_url, button_text, redirect_url, fields)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      String(data.name || 'Untitled form').slice(0, 120),
      String(data.title || '').slice(0, 200),
      String(data.description || '').slice(0, 2000),
      String(data.header_html || '').slice(0, 20000),
      String(data.footer_html || '').slice(0, 20000),
      String(data.logo_url || '').slice(0, 500),
      String(data.button_text || 'Submit').slice(0, 60),
      String(data.redirect_url || '').slice(0, 500),
      fields,
    );
    return this.getById(null, result.lastInsertRowid);
  },

  update(userId, id, data) {
    if (userId) {
      const existing = db.prepare('SELECT id FROM forms WHERE id = ? AND user_id = ?').get(id, userId);
      if (!existing) return null;
    }
    const allowed = ['name', 'title', 'description', 'header_html', 'footer_html', 'logo_url', 'button_text', 'redirect_url'];
    const fields = [];
    const params = [];
    for (const k of allowed) {
      if (k in data) { fields.push(`${k} = ?`); params.push(data[k] == null ? '' : String(data[k])); }
    }
    if ('fields' in data) { fields.push('fields = ?'); params.push(serializeFields(data.fields)); }
    fields.push("updated_at = CURRENT_TIMESTAMP");
    if (fields.length === 1) return this.getById(null, id);
    params.push(id);
    db.prepare(`UPDATE forms SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(null, id);
  },

  delete(userId, id) {
    if (userId) {
      const existing = db.prepare('SELECT id FROM forms WHERE id = ? AND user_id = ?').get(id, userId);
      if (!existing) return null;
    }
    db.prepare('UPDATE campaigns SET form_id = NULL WHERE form_id = ?').run(id);
    db.prepare('DELETE FROM form_submissions WHERE form_id = ?').run(id);
    return db.prepare('DELETE FROM forms WHERE id = ?').run(id);
  },

  recordSubmission({ formId, campaignId, leadId, data, ip, userAgent }) {
    return db.prepare(`
      INSERT INTO form_submissions (form_id, campaign_id, lead_id, data, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(formId, campaignId || null, leadId || null, JSON.stringify(data || {}), ip || null, userAgent || null);
  },

  getSubmissions(userId, formId) {
    const form = this.getById(userId, formId);
    if (!form) return null;
    const rows = db.prepare(`
      SELECT s.*, l.name as lead_name, l.email as lead_email, c.name as campaign_name
      FROM form_submissions s
      LEFT JOIN leads l ON s.lead_id = l.id
      LEFT JOIN campaigns c ON s.campaign_id = c.id
      WHERE s.form_id = ?
      ORDER BY s.submitted_at DESC
      LIMIT 500
    `).all(formId);
    return rows.map(r => ({ ...r, data: (() => { try { return JSON.parse(r.data); } catch { return {}; } })() }));
  },
};

export { ALLOWED_FIELD_TYPES };
