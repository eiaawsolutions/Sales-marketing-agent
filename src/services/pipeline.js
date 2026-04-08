import db from '../db/index.js';

export const pipelineService = {
  getAll(userId, filters = {}) {
    let query = `SELECT p.*, l.name, l.email, l.company, l.title, l.score as lead_score
      FROM pipeline p JOIN leads l ON p.lead_id = l.id WHERE 1=1`;
    const params = [];

    if (userId) { query += ' AND p.user_id = ?'; params.push(userId); }
    if (filters.stage) { query += ' AND p.stage = ?'; params.push(filters.stage); }
    if (filters.minValue) { query += ' AND p.deal_value >= ?'; params.push(filters.minValue); }

    query += ' ORDER BY p.deal_value DESC';
    return db.prepare(query).all(...params);
  },

  getById(userId, id) {
    if (userId) {
      return db.prepare(`SELECT p.*, l.name, l.email, l.company, l.title FROM pipeline p JOIN leads l ON p.lead_id = l.id WHERE p.id = ? AND p.user_id = ?`).get(id, userId);
    }
    return db.prepare(`SELECT p.*, l.name, l.email, l.company, l.title FROM pipeline p JOIN leads l ON p.lead_id = l.id WHERE p.id = ?`).get(id);
  },

  create(userId, deal) {
    const result = db.prepare(`
      INSERT INTO pipeline (user_id, lead_id, stage, deal_value, probability, expected_close_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, deal.lead_id, deal.stage || 'prospecting', deal.deal_value || 0,
      deal.probability || 10, deal.expected_close_date, deal.notes);
    return this.getById(null, result.lastInsertRowid);
  },

  update(userId, id, data) {
    const existing = this.getById(userId, id);
    if (!existing) return null;

    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(data)) {
      if (['stage', 'deal_value', 'probability', 'expected_close_date', 'notes'].includes(key)) {
        fields.push(`${key} = ?`);
        params.push(value);
      }
    }
    if (fields.length === 0) return existing;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    db.prepare(`UPDATE pipeline SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    const deal = this.getById(null, id);
    if (deal && data.stage) {
      const stageToStatus = {
        prospecting: 'new', qualification: 'qualified', proposal: 'proposal',
        negotiation: 'negotiation', closed_won: 'won', closed_lost: 'lost',
      };
      const leadStatus = stageToStatus[data.stage];
      if (leadStatus) {
        db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(leadStatus, deal.lead_id);
      }
    }
    return deal;
  },

  delete(userId, id) {
    if (userId) return db.prepare('DELETE FROM pipeline WHERE id = ? AND user_id = ?').run(id, userId);
    return db.prepare('DELETE FROM pipeline WHERE id = ?').run(id);
  },

  getStats(userId) {
    const uf = userId ? ' AND user_id = ?' : '';
    const p = userId ? [userId] : [];

    const stages = db.prepare(`SELECT stage, COUNT(*) as count, SUM(deal_value) as total_value, AVG(probability) as avg_probability
      FROM pipeline WHERE stage NOT IN ('closed_won','closed_lost')${uf} GROUP BY stage`).all(...p);
    const wonDeals = db.prepare(`SELECT COUNT(*) as count, SUM(deal_value) as total_value FROM pipeline WHERE stage = 'closed_won'${uf}`).get(...p);
    const lostDeals = db.prepare(`SELECT COUNT(*) as count, SUM(deal_value) as total_value FROM pipeline WHERE stage = 'closed_lost'${uf}`).get(...p);
    const totalOpen = db.prepare(`SELECT COUNT(*) as count, SUM(deal_value) as total_value FROM pipeline WHERE stage NOT IN ('closed_won','closed_lost')${uf}`).get(...p);
    const weightedPipeline = db.prepare(`SELECT SUM(deal_value * probability / 100.0) as weighted_value FROM pipeline WHERE stage NOT IN ('closed_won','closed_lost')${uf}`).get(...p);

    return {
      stages, won: wonDeals, lost: lostDeals, open: totalOpen,
      weightedPipelineValue: Math.round(weightedPipeline.weighted_value || 0),
      winRate: wonDeals.count + lostDeals.count > 0
        ? Math.round((wonDeals.count / (wonDeals.count + lostDeals.count)) * 100) : 0,
    };
  },
};
