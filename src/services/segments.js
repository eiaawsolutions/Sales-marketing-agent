// Segments: saved filters over a tenant's leads.
//
// The filter is an AND-of-ORs tree, the same shape HubSpot calls filterGroups:
//
//   { "match": "all",
//     "groups": [
//       { "match": "any", "conditions": [
//           { "field": "source_type", "op": "equals", "value": "calendly" },
//           { "field": "source_type", "op": "equals", "value": "google_ads" } ] },
//       { "match": "all", "conditions": [
//           { "field": "score",  "op": "gte", "value": 60 },
//           { "field": "status", "op": "in",  "value": ["new", "contacted"] } ] }
//     ] }
//
// compiles to:
//
//   SELECT l.* FROM leads l
//     LEFT JOIN lead_sources s ON s.id = l.last_source_id
//    WHERE l.user_id = ?
//      AND ((s.type = ?) OR (s.type = ?))
//      AND ((l.score >= ?) AND (l.status IN (?, ?)))
//   params: [userId, 'calendly', 'google_ads', 60, 'new', 'contacted']
//
// SQL INJECTION: field names and operators are looked up in closed maps; a name
// that is not a key produces an error, never a string splice. Every VALUE is a
// bound parameter. The only text ever concatenated into SQL comes from the maps
// below, which are literals in this file.

import db from '../db/index.js';

// field → { col, type }. `col` is a SQL fragment from this file only.
const FIELDS = {
  score: { col: 'l.score', type: 'number' },
  touch_count: { col: 'l.touch_count', type: 'number' },
  status: { col: 'l.status', type: 'string' },
  name: { col: 'l.name', type: 'string' },
  company: { col: 'l.company', type: 'string' },
  title: { col: 'l.title', type: 'string' },
  email: { col: 'l.email', type: 'string' },
  lead_type: { col: 'l.lead_type', type: 'string' },
  segment_type: { col: 'l.segment_type', type: 'string' },
  confidence_score: { col: 'l.confidence_score', type: 'string' },
  buying_signal: { col: 'l.buying_signal', type: 'string' },
  source: { col: 'l.source', type: 'string' },
  created_at: { col: 'l.created_at', type: 'date' },
  qualified_at: { col: 'l.qualified_at', type: 'date' },

  // Derived / presence
  has_email: { col: 'l.email_normalized', type: 'presence' },
  has_phone: { col: 'l.phone_normalized', type: 'presence' },
  has_linkedin: { col: 'l.linkedin_normalized', type: 'presence' },
  has_website: { col: 'l.company_website', type: 'presence' },
  email_domain: {
    col: "CASE WHEN l.email_normalized IS NULL THEN NULL ELSE substr(l.email_normalized, instr(l.email_normalized, '@') + 1) END",
    type: 'string',
  },

  // Requires the lead_sources join.
  source_type: { col: 's.type', type: 'string', join: true },
  source_name: { col: 's.name', type: 'string', join: true },
  source_id: { col: 'l.last_source_id', type: 'number' },
};

// LIKE treats % and _ as wildcards. A user searching for "50%_off" must not get
// a wildcard scan, so escape them and declare the escape character.
function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

const MAX_GROUPS = 10;
const MAX_CONDITIONS_PER_GROUP = 20;
const MAX_TOTAL_CONDITIONS = 100;
const MAX_IN_VALUES = 50;
const MAX_VALUE_LENGTH = 200;

class FilterError extends Error {}

function coerce(field, value) {
  const meta = FIELDS[field];
  if (meta.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new FilterError(`Field "${field}" needs a number, got ${JSON.stringify(value)}`);
    return n;
  }
  const s = String(value);
  if (s.length > MAX_VALUE_LENGTH) throw new FilterError(`Value for "${field}" is too long`);
  return s;
}

// op → (col, value) → { sql, params }
const OPS = {
  equals: (col, v, f) => ({ sql: `${col} = ?`, params: [coerce(f, v)] }),
  not_equals: (col, v, f) => ({ sql: `(${col} IS NULL OR ${col} != ?)`, params: [coerce(f, v)] }),
  contains: (col, v, f) => ({ sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${likeEscape(coerce(f, v))}%`] }),
  not_contains: (col, v, f) => ({ sql: `(${col} IS NULL OR ${col} NOT LIKE ? ESCAPE '\\')`, params: [`%${likeEscape(coerce(f, v))}%`] }),
  starts_with: (col, v, f) => ({ sql: `${col} LIKE ? ESCAPE '\\'`, params: [`${likeEscape(coerce(f, v))}%`] }),
  ends_with: (col, v, f) => ({ sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${likeEscape(coerce(f, v))}`] }),
  gte: (col, v, f) => ({ sql: `${col} >= ?`, params: [coerce(f, v)] }),
  lte: (col, v, f) => ({ sql: `${col} <= ?`, params: [coerce(f, v)] }),
  gt: (col, v, f) => ({ sql: `${col} > ?`, params: [coerce(f, v)] }),
  lt: (col, v, f) => ({ sql: `${col} < ?`, params: [coerce(f, v)] }),
  before: (col, v, f) => ({ sql: `${col} < ?`, params: [coerce(f, v)] }),
  after: (col, v, f) => ({ sql: `${col} > ?`, params: [coerce(f, v)] }),
  // "within the last N days" — N is a bound parameter, and the modifier string
  // is built from a validated integer, never from raw input.
  in_last_days: (col, v, f) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw new FilterError(`in_last_days needs 0-3650, got ${JSON.stringify(v)}`);
    return { sql: `${col} >= datetime('now', ?)`, params: [`-${n} days`] };
  },
  in: (col, v, f) => {
    const list = Array.isArray(v) ? v : [v];
    if (!list.length) throw new FilterError(`"in" needs at least one value`);
    if (list.length > MAX_IN_VALUES) throw new FilterError(`"in" accepts at most ${MAX_IN_VALUES} values`);
    return { sql: `${col} IN (${list.map(() => '?').join(', ')})`, params: list.map((x) => coerce(f, x)) };
  },
  not_in: (col, v, f) => {
    const list = Array.isArray(v) ? v : [v];
    if (!list.length) throw new FilterError(`"not_in" needs at least one value`);
    if (list.length > MAX_IN_VALUES) throw new FilterError(`"not_in" accepts at most ${MAX_IN_VALUES} values`);
    return { sql: `(${col} IS NULL OR ${col} NOT IN (${list.map(() => '?').join(', ')}))`, params: list.map((x) => coerce(f, x)) };
  },
  is_present: (col) => ({ sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] }),
  is_absent: (col) => ({ sql: `(${col} IS NULL OR ${col} = '')`, params: [] }),
};

// Which operators are legal on which field type. Prevents nonsense like
// `score contains "abc"` compiling to a LIKE on an integer column.
const OPS_BY_TYPE = {
  number: ['equals', 'not_equals', 'gte', 'lte', 'gt', 'lt', 'in', 'not_in', 'is_present', 'is_absent'],
  string: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_present', 'is_absent'],
  date: ['before', 'after', 'in_last_days', 'is_present', 'is_absent'],
  presence: ['is_present', 'is_absent'],
};

function compileCondition(cond) {
  if (!cond || typeof cond !== 'object') throw new FilterError('Condition must be an object');
  const { field, op, value } = cond;

  if (typeof field !== 'string' || !Object.hasOwn(FIELDS, field)) {
    throw new FilterError(`Unknown field: ${JSON.stringify(field)}`);
  }
  if (typeof op !== 'string' || !Object.hasOwn(OPS, op)) {
    throw new FilterError(`Unknown operator: ${JSON.stringify(op)}`);
  }
  const meta = FIELDS[field];
  if (!OPS_BY_TYPE[meta.type].includes(op)) {
    throw new FilterError(`Operator "${op}" is not allowed on field "${field}" (${meta.type})`);
  }
  const { sql, params } = OPS[op](meta.col, value, field);
  return { sql, params, join: !!meta.join };
}

// ---------------------------------------------------------------------------
// compileSegmentFilter(filter, userId) → { sql, params, needsJoin }
//
// `sql` is a complete SELECT over leads. Pure — no DB access, safe to unit test.
// ---------------------------------------------------------------------------
export function compileSegmentFilter(filter, userId, { select = 'l.*' } = {}) {
  if (!filter || typeof filter !== 'object') throw new FilterError('Filter must be an object');
  const outerMatch = filter.match === 'any' ? 'OR' : 'AND';
  const groups = Array.isArray(filter.groups) ? filter.groups : [];
  if (groups.length > MAX_GROUPS) throw new FilterError(`At most ${MAX_GROUPS} groups`);

  let totalConditions = 0;
  let needsJoin = false;
  const groupSql = [];
  const params = [userId];

  for (const group of groups) {
    if (!group || typeof group !== 'object') throw new FilterError('Group must be an object');
    const innerMatch = group.match === 'any' ? 'OR' : 'AND';
    const conditions = Array.isArray(group.conditions) ? group.conditions : [];
    if (!conditions.length) continue; // An empty group constrains nothing.
    if (conditions.length > MAX_CONDITIONS_PER_GROUP) throw new FilterError(`At most ${MAX_CONDITIONS_PER_GROUP} conditions per group`);
    totalConditions += conditions.length;
    if (totalConditions > MAX_TOTAL_CONDITIONS) throw new FilterError(`At most ${MAX_TOTAL_CONDITIONS} conditions total`);

    const parts = [];
    for (const cond of conditions) {
      const c = compileCondition(cond);
      needsJoin = needsJoin || c.join;
      parts.push(`(${c.sql})`);
      params.push(...c.params);
    }
    groupSql.push(`(${parts.join(` ${innerMatch} `)})`);
  }

  const join = needsJoin ? 'LEFT JOIN lead_sources s ON s.id = l.last_source_id' : '';
  // No groups → the segment is every lead the tenant owns. `user_id = ?` is
  // ALWAYS present and is never derived from user input.
  const where = groupSql.length ? ` AND (${groupSql.join(` ${outerMatch} `)})` : '';

  return {
    sql: `SELECT ${select} FROM leads l ${join} WHERE l.user_id = ?${where}`,
    params,
    needsJoin,
  };
}

export function validateFilter(filter) {
  try {
    compileSegmentFilter(filter, 0);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof FilterError ? e.message : 'Invalid filter' };
  }
}

export const EMPTY_FILTER = { match: 'all', groups: [] };

// Shape offered to the UI so the filter builder never invents a field or op.
export function filterSchema() {
  return {
    fields: Object.entries(FIELDS).map(([name, meta]) => ({
      name, type: meta.type, ops: OPS_BY_TYPE[meta.type],
    })),
    matches: ['all', 'any'],
    limits: { MAX_GROUPS, MAX_CONDITIONS_PER_GROUP, MAX_TOTAL_CONDITIONS, MAX_IN_VALUES, MAX_VALUE_LENGTH },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export const segmentsService = {
  getAll(userId) {
    const rows = db.prepare(
      'SELECT * FROM segments WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
    return rows.map((r) => ({ ...r, filter: safeParse(r.filter) }));
  },

  getById(userId, id) {
    const row = db.prepare('SELECT * FROM segments WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return null;
    return { ...row, filter: safeParse(row.filter) };
  },

  create(userId, input) {
    const name = String(input.name || '').trim().slice(0, 120);
    if (!name) throw new Error('Segment name is required');
    const kind = input.kind === 'static' ? 'static' : 'dynamic';
    const filter = kind === 'dynamic' ? (input.filter || EMPTY_FILTER) : EMPTY_FILTER;

    if (kind === 'dynamic') {
      const check = validateFilter(filter);
      if (!check.valid) throw new Error(check.error);
    }

    const res = db.prepare(`
      INSERT INTO segments (user_id, name, description, kind, filter)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, name, String(input.description || '').slice(0, 500) || null, kind, JSON.stringify(filter));
    return this.getById(userId, res.lastInsertRowid);
  },

  update(userId, id, input) {
    const existing = this.getById(userId, id);
    if (!existing) return null;

    const fields = [];
    const params = [];
    if (typeof input.name === 'string' && input.name.trim()) {
      fields.push('name = ?'); params.push(input.name.trim().slice(0, 120));
    }
    if (typeof input.description === 'string') {
      fields.push('description = ?'); params.push(input.description.slice(0, 500) || null);
    }
    if (input.filter !== undefined) {
      const check = validateFilter(input.filter);
      if (!check.valid) throw new Error(check.error);
      fields.push('filter = ?'); params.push(JSON.stringify(input.filter));
    }
    if (!fields.length) return existing;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id, userId);
    db.prepare(`UPDATE segments SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
    return this.getById(userId, id);
  },

  delete(userId, id) {
    return db.prepare('DELETE FROM segments WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  },

  // Members of a dynamic segment are computed live; static segments read the
  // join table. Both are always scoped to the owning tenant.
  members(userId, id, { limit = 500 } = {}) {
    const seg = this.getById(userId, id);
    if (!seg) return null;

    if (seg.kind === 'static') {
      return db.prepare(`
        SELECT l.* FROM segment_members m
          JOIN leads l ON l.id = m.lead_id
         WHERE m.segment_id = ? AND l.user_id = ?
         ORDER BY l.score DESC, l.created_at DESC
         LIMIT ?
      `).all(id, userId, Math.min(limit, 2000));
    }

    const { sql, params } = compileSegmentFilter(seg.filter, userId);
    return db.prepare(`${sql} ORDER BY l.score DESC, l.created_at DESC LIMIT ?`)
      .all(...params, Math.min(limit, 2000));
  },

  count(userId, id) {
    const seg = this.getById(userId, id);
    if (!seg) return null;
    let c;
    if (seg.kind === 'static') {
      c = db.prepare(`
        SELECT COUNT(*) AS c FROM segment_members m JOIN leads l ON l.id = m.lead_id
         WHERE m.segment_id = ? AND l.user_id = ?
      `).get(id, userId).c;
    } else {
      const { sql, params } = compileSegmentFilter(seg.filter, userId, { select: 'COUNT(*) AS c' });
      c = db.prepare(sql).get(...params).c;
    }
    db.prepare("UPDATE segments SET last_count = ?, last_evaluated_at = CURRENT_TIMESTAMP WHERE id = ?").run(c, id);
    return c;
  },

  // Preview a filter before saving it. Never persists.
  preview(userId, filter, limit = 25) {
    const { sql, params } = compileSegmentFilter(filter, userId);
    const rows = db.prepare(`${sql} ORDER BY l.score DESC LIMIT ?`).all(...params, Math.min(limit, 100));
    const { sql: countSql, params: countParams } = compileSegmentFilter(filter, userId, { select: 'COUNT(*) AS c' });
    return { total: db.prepare(countSql).get(...countParams).c, sample: rows };
  },

  addMembers(userId, id, leadIds) {
    const seg = this.getById(userId, id);
    if (!seg || seg.kind !== 'static') return null;
    const ins = db.prepare('INSERT OR IGNORE INTO segment_members (segment_id, lead_id) VALUES (?, ?)');
    // Ownership check per lead — a caller must not add another tenant's lead.
    const owns = db.prepare('SELECT 1 FROM leads WHERE id = ? AND user_id = ?');
    let added = 0;
    const run = db.transaction(() => {
      for (const leadId of leadIds.slice(0, 5000)) {
        if (owns.get(leadId, userId)) added += ins.run(id, leadId).changes;
      }
    });
    run();
    return added;
  },

  removeMembers(userId, id, leadIds) {
    const seg = this.getById(userId, id);
    if (!seg || seg.kind !== 'static') return null;
    const del = db.prepare('DELETE FROM segment_members WHERE segment_id = ? AND lead_id = ?');
    let removed = 0;
    const run = db.transaction(() => {
      for (const leadId of leadIds.slice(0, 5000)) removed += del.run(id, leadId).changes;
    });
    run();
    return removed;
  },
};

function safeParse(json) {
  try { return JSON.parse(json); } catch { return EMPTY_FILTER; }
}

export const __testing = { FilterError, likeEscape, FIELDS, OPS_BY_TYPE };
