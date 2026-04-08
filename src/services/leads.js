import db from '../db/index.js';

export const leadsService = {
  getAll(userId, filters = {}) {
    let query = `SELECT l.*,
      (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.status IN ('sent','opened','clicked','replied')) as sent_count,
      (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.status IN ('opened','clicked','replied')) as open_count,
      (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.status IN ('clicked','replied')) as click_count
      FROM leads l WHERE 1=1`;
    const params = [];

    if (userId) { query += ' AND l.user_id = ?'; params.push(userId); }
    if (filters.status) { query += ' AND l.status = ?'; params.push(filters.status); }
    if (filters.minScore) { query += ' AND l.score >= ?'; params.push(filters.minScore); }
    if (filters.source) { query += ' AND l.source = ?'; params.push(filters.source); }
    if (filters.search) {
      query += ' AND (l.name LIKE ? OR l.email LIKE ? OR l.company LIKE ?)';
      const term = `%${filters.search}%`;
      params.push(term, term, term);
    }

    query += ' ORDER BY l.score DESC, l.created_at DESC';
    if (filters.limit) { query += ' LIMIT ?'; params.push(filters.limit); }

    return db.prepare(query).all(...params);
  },

  getById(userId, id) {
    if (userId) return db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(id, userId);
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  },

  create(userId, lead) {
    const result = db.prepare(`
      INSERT INTO leads (user_id, name, email, company, title, phone, source, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, lead.name, lead.email, lead.company, lead.title, lead.phone, lead.source || 'manual', lead.notes);
    return this.getById(null, result.lastInsertRowid);
  },

  update(userId, id, data) {
    // Verify ownership
    const existing = this.getById(userId, id);
    if (!existing) return null;

    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(data)) {
      if (['name', 'email', 'company', 'title', 'phone', 'source', 'score', 'status', 'notes'].includes(key)) {
        fields.push(`${key} = ?`);
        params.push(value);
      }
    }
    if (fields.length === 0) return existing;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(null, id);
  },

  delete(userId, id) {
    if (userId) return db.prepare('DELETE FROM leads WHERE id = ? AND user_id = ?').run(id, userId);
    return db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  },

  getActivities(userId, leadId) {
    if (userId) {
      return db.prepare(
        'SELECT a.* FROM activities a JOIN leads l ON a.lead_id = l.id WHERE a.lead_id = ? AND l.user_id = ? ORDER BY a.created_at DESC'
      ).all(leadId, userId);
    }
    return db.prepare('SELECT * FROM activities WHERE lead_id = ? ORDER BY created_at DESC').all(leadId);
  },

  addActivity(userId, leadId, activity) {
    const result = db.prepare(
      'INSERT INTO activities (user_id, lead_id, type, description, outcome) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, leadId, activity.type, activity.description, activity.outcome);
    return db.prepare('SELECT * FROM activities WHERE id = ?').get(result.lastInsertRowid);
  },

  getStats(userId) {
    const uw = userId ? ' WHERE user_id = ?' : '';
    const uf = userId ? ' AND user_id = ?' : '';
    const p = userId ? [userId] : [];

    const total = db.prepare(`SELECT COUNT(*) as count FROM leads${uw}`).get(...p);
    const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM leads${uw} GROUP BY status`).all(...p);
    const bySource = db.prepare(`SELECT source, COUNT(*) as count FROM leads${uw} GROUP BY source`).all(...p);
    const avgScore = db.prepare(`SELECT AVG(score) as avg FROM leads${uw}`).get(...p);
    const recentLeads = db.prepare(`SELECT * FROM leads${uw} ORDER BY created_at DESC LIMIT 5`).all(...p);
    const topLeads = db.prepare(`SELECT * FROM leads${uw} ORDER BY score DESC LIMIT 5`).all(...p);

    return {
      total: total.count, byStatus, bySource,
      averageScore: Math.round(avgScore.avg || 0),
      recentLeads, topLeads,
    };
  },
};
