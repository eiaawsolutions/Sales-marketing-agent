import db from '../db/index.js';

// Mask contact details for non-superadmin users
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return '***@***.com';
  return local.charAt(0) + '*'.repeat(Math.max(local.length - 2, 1)) + local.charAt(local.length - 1) + '@' + domain;
}

function maskPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***-****';
  return phone.substring(0, 4) + '*'.repeat(phone.length - 6) + phone.substring(phone.length - 2);
}


// Contact details are what a reveal credit pays for, so email and phone stay
// masked. The name is shown in full: every verified lead already carries its
// public profile link, and the team needs the name to send a LinkedIn note.
export function maskLead(lead) {
  if (!lead) return lead;
  return {
    ...lead,
    email: maskEmail(lead.email),
    phone: maskPhone(lead.phone),
    _masked: true,
  };
}

// Lines the lead generators and ingest write into notes (ai-agent.js
// buildNotes, the Apollo path, referrals), read back for "why this score".
const SIGNAL_LABELS = {
  'Buying signal': 'Buying signal', 'Enrichment': 'Recent activity', 'Fit': 'Fit',
  'Apollo source': 'Contact database', 'Referral': 'Referral', 'Reason for fit': 'Fit',
};

export function signalsFromNotes(notes) {
  const signals = [];
  const sources = [];
  for (const line of String(notes || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z ]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (SIGNAL_LABELS[key]) signals.push({ label: SIGNAL_LABELS[key], text: value.trim().slice(0, 400) });
    if (['Verification', 'Profile', 'Website'].includes(key)) {
      for (const part of value.split('|')) {
        const url = part.trim();
        if (/^https?:\/\/\S+$/i.test(url) && !sources.includes(url)) sources.push(url);
      }
    }
  }
  return { signals, sources };
}

/** The score and the reasons behind it — no contact details. */
export function scoreView(lead) {
  let detail = null;
  try { detail = lead.score_detail ? JSON.parse(lead.score_detail) : null; } catch { detail = null; }
  return {
    id: lead.id, name: lead.name, title: lead.title || '', company: lead.company || '',
    score: lead.score || 0, status: lead.status,
    bant: detail?.bant || null, reasoning: detail?.reasoning || '', next_step: detail?.next_step || '',
    scored_at: detail?.scored_at || null,
    call: detail?.call || null,
    ...signalsFromNotes(lead.notes),
  };
}

// The voice assistant ends every customer call with log_call_outcome, whose
// summary starts "Need: …; Budget: …; Authority: …; Timeline: …" (the prompt
// asks for exactly this). Read the four back; "unknown" counts as not said.
export function readCallBant(summary) {
  const out = {};
  for (const key of ['need', 'budget', 'authority', 'timeline']) {
    const m = String(summary || '').match(new RegExp(`${key}\\s*:\\s*([^;\\n]+)`, 'i'));
    const v = m ? m[1].trim().replace(/[.\s]+$/, '') : '';
    if (v && !/^(unknown|n\/?a|not discussed|none)$/i.test(v)) out[key] = v.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Keep what a call captured on the lead (shown with its score), and log it
 * on the timeline. Returns the captured fields, or null if the summary had
 * none. The caller re-scores the lead so the score reflects the call.
 */
export function recordCallCapture(userId, leadId, summary, callId) {
  const call = readCallBant(summary);
  if (!call) return null;
  const lead = db.prepare('SELECT score_detail FROM leads WHERE id = ? AND user_id = ?').get(leadId, userId);
  if (!lead) return null;
  let detail = {};
  try { detail = lead.score_detail ? JSON.parse(lead.score_detail) : {}; } catch { detail = {}; }
  detail.call = { ...call, at: new Date().toISOString(), call_id: callId || null };
  db.prepare('UPDATE leads SET score_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(JSON.stringify(detail), leadId, userId);
  const line = ['need', 'budget', 'authority', 'timeline'].filter(k => call[k]).map(k => `${k[0].toUpperCase()}${k.slice(1)}: ${call[k]}`).join('; ');
  db.prepare("INSERT INTO activities (user_id, lead_id, type, description) VALUES (?, ?, 'note', ?)")
    .run(userId, leadId, `What the call captured — ${line}`.slice(0, 1000));
  return call;
}

// A lead someone has written to (an email or a LinkedIn note went out) is
// Contacted. Only from New: a lead already further along keeps its stage.
export function markContacted(leadId) {
  db.prepare("UPDATE leads SET status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'new'").run(leadId);
}

// How a LinkedIn note the team sent from their own account is logged on the lead.
export const LINKEDIN_NOTE_SENT = 'LinkedIn connection note sent from your own account';

// When this lead's LinkedIn note was marked sent, or null. LinkedIn takes one
// invitation per person, so there is never a second.
export function linkedinNoteSentAt(leadId) {
  return db.prepare("SELECT created_at FROM activities WHERE lead_id = ? AND type = 'note' AND description LIKE ? ORDER BY id DESC LIMIT 1")
    .get(leadId, `${LINKEDIN_NOTE_SENT}%`)?.created_at ?? null;
}

export function maskLeads(leads) {
  return leads.map(maskLead);
}

export const leadsService = {
  getAll(userId, filters = {}) {
    let query = `SELECT l.*,
      (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.status IN ('sent','opened','clicked','replied')) as sent_count,
      (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.status IN ('opened','clicked','replied')) as open_count,
      (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.lead_id = l.id AND cl.status IN ('clicked','replied')) as click_count,
      (
        SELECT GROUP_CONCAT(c.id || '::' || c.name, '||')
        FROM campaign_leads cl3
        JOIN campaigns c ON c.id = cl3.campaign_id
        WHERE cl3.lead_id = l.id
      ) as campaigns_raw
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

    const rows = db.prepare(query).all(...params);
    return rows.map(r => {
      const campaigns = r.campaigns_raw
        ? r.campaigns_raw.split('||').map(pair => {
            const [id, ...nameParts] = pair.split('::');
            return { id: parseInt(id, 10), name: nameParts.join('::') };
          })
        : [];
      const { campaigns_raw, ...rest } = r;
      return { ...rest, campaigns };
    });
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
