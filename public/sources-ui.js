// ============================================================
// EIAAW Sources hub — omnichannel lead funnel UI
// ------------------------------------------------------------
// One nav item ("Sources") with four tabs:
//   Connections | Inbox | Scoring | Segments
//
// Loaded as a classic script BEFORE app.js. It reuses app.js globals
// (api, esc, showNotification, modal, render, navigate) at CALL time — they
// exist by the time the user navigates here, even though they are undefined at
// load time. Everything the UI needs is exposed via window.* for onclick.
//
// Matches the locked EIAAW visual language: warm-cream bg, teal primary,
// existing .card / .btn / .badge / .toolbar classes. No new design system.
// ============================================================

(function () {
  'use strict';

  const S = {
    tab: 'connections',
    sources: [],
    funnel: [],
    inbox: [],
    inboxStatus: 'pending',
    inboxCounts: { pending: 0, accepted: 0, rejected: 0, duplicate: 0, error: 0 },
    rules: [],
    leadSettings: null,
    segments: [],
    types: null,
  };

  const esc = (s) => (window.esc ? window.esc(s) : String(s == null ? '' : s));
  const notify = (m, t) => window.showNotification && window.showNotification(m, t);

  // ---- health / status pills --------------------------------------------
  function healthPill(h) {
    if (h === 'ok') return `<span class="badge" style="background:rgba(34,197,94,0.14);color:#15803d;border:1px solid rgba(34,197,94,0.4);font-weight:700">&#9679; OK</span>`;
    if (h === 'error') return `<span class="badge" style="background:rgba(220,38,38,0.12);color:#b91c1c;border:1px solid rgba(220,38,38,0.4);font-weight:700">&#9679; Error</span>`;
    return `<span class="badge" style="background:rgba(107,122,127,0.12);color:#6B7A7F;border:1px solid rgba(107,122,127,0.3)">&#9675; No data yet</span>`;
  }
  function statusPill(status) {
    const map = { active: ['Active', '#15803d', 'rgba(34,197,94,0.14)'], paused: ['Paused', '#b45309', 'rgba(245,158,11,0.14)'], disabled: ['Disabled', '#6B7A7F', 'rgba(107,122,127,0.12)'] };
    const [label, color, bg] = map[status] || map.disabled;
    return `<span class="badge" style="background:${bg};color:${color};border:1px solid ${color}55">${label}</span>`;
  }

  // ========================================================================
  // Entry point — called by app.js afterRender switch
  // ========================================================================
  async function loadSources() {
    const page = document.getElementById('page');
    if (!page) return;
    page.innerHTML = shell(spinner());
    try {
      await refreshCounts();
      renderTab();
    } catch (e) {
      const body = document.getElementById('sources-body');
      if (body) body.innerHTML = `<div class="empty" style="padding:40px">Could not load Sources: ${esc(e.message)}</div>`;
    }
  }

  function shell(inner) {
    const tab = (id, label, badge) => `
      <button class="btn ${S.tab === id ? 'btn-primary' : 'btn-outline'}" style="border-radius:8px" onclick="Sources_tab('${id}')">
        ${label}${badge ? ` <span style="opacity:.85">(${badge})</span>` : ''}
      </button>`;
    return `
      <div class="toolbar">
        <h2>Sources</h2>
        <button class="btn btn-outline" onclick="Sources_reload()" title="Refresh">&#8635; Refresh</button>
      </div>
      <div class="card" style="padding:14px;margin-bottom:16px">
        <p class="text-muted text-sm" style="margin:0">
          Connect every place your leads come from — ad forms, your website, booking links, email, Zapier — and funnel them all into one qualified pipeline.
          New leads land in the <strong>Inbox</strong> for review, get scored automatically, and the strong ones are qualified by AI and pushed into the pipeline.
        </p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${tab('connections', 'Connections')}
        ${tab('inbox', 'Inbox', S.inboxCounts.pending || '')}
        ${tab('scoring', 'Scoring')}
        ${tab('segments', 'Segments')}
      </div>
      <div id="sources-body">${inner}</div>
    `;
  }

  const spinner = () => '<div class="loading" style="padding:40px">Loading…</div>';

  async function refreshCounts() {
    try { S.inboxCounts = await window.api.get('/sources/inbox/counts'); } catch { /* non-fatal */ }
  }

  async function renderTab() {
    const page = document.getElementById('page');
    if (!page) return;
    page.innerHTML = shell(spinner());
    const body = document.getElementById('sources-body');
    try {
      if (S.tab === 'connections') return renderConnections(body);
      if (S.tab === 'inbox') return renderInbox(body);
      if (S.tab === 'scoring') return renderScoring(body);
      if (S.tab === 'segments') return renderSegments(body);
    } catch (e) {
      body.innerHTML = `<div class="empty" style="padding:40px">Error: ${esc(e.message)}</div>`;
    }
  }

  // ========================================================================
  // CONNECTIONS
  // ========================================================================
  async function renderConnections(body) {
    const [sources, funnel] = await Promise.all([
      window.api.get('/sources'),
      window.api.get('/sources/funnel'),
    ]);
    S.sources = sources;
    S.funnel = funnel;
    const funnelById = Object.fromEntries(funnel.map((f) => [f.id, f]));

    const inbound = sources.filter((s) => s.auth_mode !== 'internal');
    const builtin = sources.filter((s) => s.auth_mode === 'internal');

    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px">
        <h3 style="margin:0">Connected sources</h3>
        <button class="btn btn-primary" onclick="Sources_connect()">+ Connect a source</button>
      </div>

      ${inbound.length === 0 ? `
        <div class="empty" style="padding:36px;text-align:center">
          <div style="font-size:30px;margin-bottom:8px">&#128268;</div>
          <p class="text-muted">No external sources connected yet.</p>
          <button class="btn btn-primary" onclick="Sources_connect()" style="margin-top:10px">+ Connect your first source</button>
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
          ${inbound.map((s) => sourceCard(s, funnelById[s.id])).join('')}
        </div>
      `}

      ${builtin.length ? `
        <h3 style="margin:22px 0 10px">Built-in sources</h3>
        <p class="text-muted text-sm" style="margin:-4px 0 12px">Managed automatically — manual entry, CSV import, Apollo, AI web search, and voice all feed the same funnel.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">
          ${builtin.map((s) => {
            const f = funnelById[s.id] || {};
            return `<div class="card" style="padding:14px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <strong>${esc(s.label || s.name)}</strong>${statusPill(s.status)}
              </div>
              <div class="text-muted text-sm" style="margin-top:6px">${f.leads_count || 0} leads · ${f.deals_count || 0} deals</div>
            </div>`;
          }).join('')}
        </div>
      ` : ''}
    `;
  }

  function sourceCard(s, f) {
    f = f || {};
    const conv = f.leads_count && f.received_count ? Math.round((f.leads_count / f.received_count) * 100) : null;
    return `
      <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div>
            <strong style="font-size:15px">${esc(s.name)}</strong>
            <div class="text-muted text-sm">${esc(s.label || s.type)}</div>
          </div>
          <div style="display:flex;gap:4px;flex-direction:column;align-items:flex-end">${statusPill(s.status)}${healthPill(s.health)}</div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:8px 0">
          ${stat('Received', f.received_count || 0)}
          ${stat('Pending', f.pending_count || 0)}
          ${stat('Leads', f.leads_count || 0)}
          ${stat('Deals', f.deals_count || 0)}
        </div>
        ${conv !== null ? `<div class="text-muted text-sm">Lead conversion: <strong>${conv}%</strong>${f.rejected_count ? ` · ${f.rejected_count} rejected` : ''}</div>` : ''}
        ${s.last_error ? `<div class="text-sm" style="color:var(--danger)">Last error: ${esc(s.last_error)}</div>` : ''}

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
          <button class="btn btn-outline btn-sm" onclick="Sources_view(${s.id})">Setup</button>
          <button class="btn btn-outline btn-sm" onclick="Sources_toggle(${s.id},'${s.status === 'active' ? 'paused' : 'active'}')">${s.status === 'active' ? 'Pause' : 'Resume'}</button>
          <button class="btn btn-outline btn-sm" onclick="Sources_delete(${s.id})" style="color:var(--danger)">Delete</button>
        </div>
      </div>`;
  }

  const stat = (label, value) => `<div><div style="font-size:18px;font-weight:700">${value}</div><div class="text-muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.03em">${label}</div></div>`;

  async function connect() {
    if (!S.types) { try { S.types = await window.api.get('/sources/types'); } catch (e) { return notify(e.message, 'error'); } }
    const opts = S.types.available.map((t) => `
      <label class="card" style="padding:12px;display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin:0">
        <input type="radio" name="src-type" value="${esc(t.type)}" style="margin-top:3px">
        <div><strong>${esc(t.label)}</strong><div class="text-muted text-sm">${esc(t.description)}</div></div>
      </label>`).join('');
    const gated = (S.types.gated || []).map((g) => `<li>${esc(g.label)} — <span class="text-muted">${esc(g.blocker)}</span></li>`).join('');

    window.modal = {
      title: 'Connect a source',
      saveLabel: 'Create',
      body: `
        <label class="text-sm" style="font-weight:600">Name this connection</label>
        <input id="src-name" class="input" placeholder="e.g. Website contact form" style="margin-bottom:14px">
        <label class="text-sm" style="font-weight:600;display:block;margin-bottom:6px">Type</label>
        <div style="display:grid;gap:8px;max-height:320px;overflow:auto">${opts}</div>
        ${gated ? `<details style="margin-top:12px"><summary class="text-muted text-sm" style="cursor:pointer">Coming soon (need platform approval)</summary><ul class="text-muted text-sm" style="margin:8px 0 0;padding-left:18px">${gated}</ul></details>` : ''}
      `,
      onSave: async () => {
        const type = document.querySelector('input[name="src-type"]:checked')?.value;
        const name = document.getElementById('src-name').value.trim();
        if (!type) return notify('Pick a source type', 'error');
        try {
          const created = await window.api.post('/sources', { type, name: name || undefined });
          window.modal = null; window.render();
          showSetup(created); // shows the secret + ingest URL exactly once
          await refreshCounts();
        } catch (e) { notify(e.message, 'error'); }
      },
    };
    window.render();
  }

  async function viewSource(id) {
    try {
      const s = await window.api.get('/sources/' + id);
      showSetup(s, true);
    } catch (e) { notify(e.message, 'error'); }
  }

  // The setup sheet. `created.secret` is present only right after creation.
  function showSetup(s, reopened) {
    const url = s.ingest_url || '';
    const isPublic = s.auth_mode === 'public';
    const isInbound = s.auth_mode !== 'internal';
    const example = signingExample(s, url);

    window.modal = {
      title: `Setup — ${esc(s.name)}`,
      saveLabel: 'Done',
      body: `
        ${isInbound ? `
          <label class="text-sm" style="font-weight:600">Ingest URL</label>
          <div style="display:flex;gap:6px;margin-bottom:12px">
            <input class="input" value="${esc(url)}" readonly onclick="this.select()" style="font-family:monospace;font-size:12px">
            <button class="btn btn-outline btn-sm" onclick="Sources_copy('${esc(url)}')">Copy</button>
          </div>` : `<p class="text-muted text-sm">This is a built-in source — it feeds the funnel automatically. Nothing to configure.</p>`}

        ${s.secret ? `
          <div class="card" style="padding:12px;margin-bottom:12px;border:1px solid var(--primary);background:var(--primary-light)">
            <label class="text-sm" style="font-weight:700">Signing secret — shown once, copy it now</label>
            <div style="display:flex;gap:6px;margin-top:6px">
              <input class="input" value="${esc(s.secret)}" readonly onclick="this.select()" style="font-family:monospace;font-size:12px">
              <button class="btn btn-primary btn-sm" onclick="Sources_copy('${esc(s.secret)}')">Copy</button>
            </div>
            <div class="text-muted text-sm" style="margin-top:6px">We store only a hashed copy. If you lose it, rotate for a new one.</div>
          </div>` : (isInbound && !isPublic ? `
          <div class="text-muted text-sm" style="margin-bottom:12px">The signing secret is hidden after creation. <a href="#" onclick="Sources_rotateSecret(${s.id});return false">Rotate</a> to get a new one.</div>` : '')}

        ${example}

        ${isInbound ? `<div style="display:flex;gap:6px;margin-top:14px">
          <button class="btn btn-outline btn-sm" onclick="Sources_rotateKey(${s.id})">Rotate URL</button>
          ${!isPublic ? `<button class="btn btn-outline btn-sm" onclick="Sources_rotateSecret(${s.id})">Rotate secret</button>` : ''}
        </div>` : ''}
      `,
      onSave: async () => { window.modal = null; window.render(); renderTab(); },
    };
    window.render();
  }

  // Copy-paste integration instructions per source type.
  function signingExample(s, url) {
    if (s.type === 'zapier') {
      return `<label class="text-sm" style="font-weight:600">Zapier / Make / n8n</label>
        <p class="text-muted text-sm">Add a "Webhook — POST" action to <code>${esc(url)}</code>. Send JSON with fields like <code>name</code>, <code>email</code>, <code>phone</code>, <code>company</code>. Add a header <code>X-Ingest-Token</code> set to your signing secret.</p>`;
    }
    if (s.type === 'google_ads') {
      return `<label class="text-sm" style="font-weight:600">Google Ads lead form</label>
        <p class="text-muted text-sm">In your lead form extension, set <strong>Webhook URL</strong> to <code>${esc(url)}</code> and <strong>Key</strong> to your signing secret. Click "Send test lead" to verify.</p>`;
    }
    if (s.type === 'calendly') {
      return `<label class="text-sm" style="font-weight:600">Calendly / Cal.com</label>
        <p class="text-muted text-sm">Create a webhook subscription for the "invitee created" / "booking created" event pointing at <code>${esc(url)}</code>, signed with your secret. Every booking becomes a lead.</p>`;
    }
    if (s.type === 'email_inbound') {
      return `<label class="text-sm" style="font-weight:600">Inbound email (Resend)</label>
        <p class="text-muted text-sm">In Resend, add a webhook for <code>email.received</code> pointing at <code>${esc(url)}</code>, and forward your capture address to the Resend receiving address. Use the Resend signing secret here.</p>`;
    }
    if (s.type === 'web_form' || s.type === 'chatbot') {
      return `<label class="text-sm" style="font-weight:600">Embed</label>
        <p class="text-muted text-sm">POST your form submissions to <code>${esc(url)}</code> as JSON. This key is public (it appears in your page), so submissions always wait in the Inbox for review.</p>`;
    }
    // webhook (HMAC)
    return `<label class="text-sm" style="font-weight:600">Signed webhook</label>
      <p class="text-muted text-sm">POST JSON to <code>${esc(url)}</code> with header:</p>
      <pre style="background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;overflow:auto;font-size:12px">X-EIAAW-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;
v1 = HMAC_SHA256(secret, "&lt;t&gt;." + rawBody)</pre>`;
  }

  // ========================================================================
  // INBOX
  // ========================================================================
  async function renderInbox(body) {
    const [rows] = await Promise.all([window.api.get('/sources/inbox/list?status=' + S.inboxStatus), refreshCounts()]);
    S.inbox = rows;
    const c = S.inboxCounts;
    const filterBtn = (st, label) => `<button class="btn ${S.inboxStatus === st ? 'btn-primary' : 'btn-outline'} btn-sm" onclick="Sources_inboxFilter('${st}')">${label} (${c[st] || 0})</button>`;

    body.innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${filterBtn('pending', 'Pending')}${filterBtn('accepted', 'Accepted')}${filterBtn('rejected', 'Rejected')}${filterBtn('duplicate', 'Duplicates')}
      </div>
      ${S.inboxStatus === 'pending' && rows.length ? `
        <div style="margin-bottom:10px;display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" onclick="Sources_bulkInbox('accept')">Accept all shown</button>
          <button class="btn btn-outline btn-sm" onclick="Sources_bulkInbox('reject')" style="color:var(--danger)">Reject all shown</button>
        </div>` : ''}
      ${rows.length === 0 ? `<div class="empty" style="padding:36px;text-align:center"><p class="text-muted">Nothing ${esc(S.inboxStatus)} right now.</p></div>` : `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${rows.map(inboxRow).join('')}
        </div>`}
    `;
  }

  function inboxRow(r) {
    const scoreColor = r.score >= 60 ? '#15803d' : r.score >= 40 ? '#b45309' : '#6B7A7F';
    const contact = [r.email, r.phone, r.company].filter(Boolean).map(esc).join(' · ');
    return `
      <div class="card" style="padding:12px 14px;display:flex;gap:12px;align-items:center">
        <div style="text-align:center;min-width:44px">
          <div style="font-size:20px;font-weight:800;color:${scoreColor}">${r.score}</div>
          <div class="text-muted" style="font-size:10px">SCORE</div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <strong>${esc(r.name || '(no name)')}</strong>
            <span class="badge" style="background:var(--primary-light);color:var(--primary-hover)">${esc(r.source_name)}</span>
            ${r.matched_lead_id ? `<span class="badge" style="background:rgba(245,158,11,0.14);color:#b45309" title="Matches an existing lead">↺ known contact</span>` : ''}
          </div>
          <div class="text-muted text-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${contact || '—'}</div>
          ${r.message ? `<div class="text-sm" style="margin-top:2px;color:var(--text)">${esc(String(r.message).slice(0, 140))}</div>` : ''}
        </div>
        ${S.inboxStatus === 'pending' ? `
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary btn-sm" onclick="Sources_accept(${r.id})">Accept</button>
            <button class="btn btn-outline btn-sm" onclick="Sources_reject(${r.id})" style="color:var(--danger)">Reject</button>
          </div>` : `<div class="text-muted text-sm">${esc(r.status)}${r.reject_reason ? ' · ' + esc(r.reject_reason) : ''}</div>`}
      </div>`;
  }

  // ========================================================================
  // SCORING
  // ========================================================================
  async function renderScoring(body) {
    const [rulesRes, settings] = await Promise.all([
      window.api.get('/sources/scoring/rules'),
      window.api.get('/sources/settings/lead'),
    ]);
    S.rules = rulesRes.rules;
    S.leadSettings = settings;

    body.innerHTML = `
      <div class="card" style="padding:16px;margin-bottom:16px">
        <h3 style="margin:0 0 10px">Thresholds</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:620px">
          <div>
            <label class="text-sm" style="font-weight:600">Auto-promote at score ≥</label>
            <input id="thr-promote" class="input" type="number" min="0" max="100" value="${settings.auto_promote_threshold}">
            <div class="text-muted text-sm">Leads from auto-promote sources at or above this skip the inbox.</div>
          </div>
          <div>
            <label class="text-sm" style="font-weight:600">AI-qualify at score ≥</label>
            <input id="thr-ai" class="input" type="number" min="0" max="100" value="${settings.ai_qualify_threshold}">
            <div class="text-muted text-sm">Only leads at or above this spend an AI qualification call.</div>
          </div>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px">
          <input id="thr-deal" type="checkbox" ${settings.auto_create_deal ? 'checked' : ''}>
          <span class="text-sm">Open a pipeline deal automatically when a lead is AI-qualified</span>
        </label>
        <button class="btn btn-primary btn-sm" onclick="Sources_saveThresholds()" style="margin-top:12px">Save thresholds</button>
      </div>

      <div class="toolbar" style="margin-bottom:10px">
        <h3 style="margin:0">Scoring rules</h3>
        <button class="btn btn-primary btn-sm" onclick="Sources_addRule()">+ Add rule</button>
      </div>
      <p class="text-muted text-sm" style="margin:-4px 0 12px">Every rule that matches adds (or subtracts) points. Score is capped 0–100. Intent beats identity — a booked meeting should outweigh a job title.</p>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${S.rules.map(ruleRow).join('')}
      </div>
    `;
  }

  function ruleRow(r) {
    return `
      <div class="card" style="padding:10px 14px;display:flex;gap:10px;align-items:center">
        <label class="switch" style="display:flex;align-items:center">
          <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="Sources_toggleRule(${r.id}, this.checked)">
        </label>
        <div style="flex:1">
          <strong>${esc(r.name)}</strong>
          <div class="text-muted text-sm"><code>${esc(r.field)}</code> ${esc(r.op)}${r.value ? ' ' + esc(r.value) : ''}</div>
        </div>
        <div style="font-weight:800;min-width:44px;text-align:right;color:${r.points >= 0 ? '#15803d' : 'var(--danger)'}">${r.points > 0 ? '+' : ''}${r.points}</div>
        <button class="btn btn-outline btn-sm" onclick="Sources_editRule(${r.id})">Edit</button>
        <button class="btn btn-outline btn-sm" onclick="Sources_deleteRule(${r.id})" style="color:var(--danger)">×</button>
      </div>`;
  }

  function ruleModal(existing) {
    const fields = ['source_type', 'title', 'company', 'name', 'message', 'email', 'email_domain', 'phone', 'linkedin_url', 'company_website', 'lead_type', 'confidence_score', 'is_freemail'];
    const ops = ['is_present', 'is_absent', 'equals', 'not_equals', 'contains', 'contains_any', 'in', 'starts_with', 'is_true', 'is_false', 'gte', 'lte'];
    const r = existing || { name: '', field: 'title', op: 'contains_any', value: '', points: 10 };
    window.modal = {
      title: existing ? 'Edit rule' : 'Add scoring rule',
      saveLabel: 'Save',
      body: `
        <label class="text-sm" style="font-weight:600">Name</label>
        <input id="rule-name" class="input" value="${esc(r.name)}" placeholder="e.g. Decision-maker title" style="margin-bottom:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><label class="text-sm" style="font-weight:600">Field</label>
            <select id="rule-field" class="input">${fields.map((f) => `<option ${f === r.field ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
          <div><label class="text-sm" style="font-weight:600">Operator</label>
            <select id="rule-op" class="input">${ops.map((o) => `<option ${o === r.op ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
        </div>
        <label class="text-sm" style="font-weight:600;margin-top:10px;display:block">Value (comma-separate for "in"/"contains_any"; leave blank for present/absent)</label>
        <input id="rule-value" class="input" value="${esc(r.value || '')}" style="margin-bottom:10px">
        <label class="text-sm" style="font-weight:600">Points (−100 to 100)</label>
        <input id="rule-points" class="input" type="number" min="-100" max="100" value="${r.points}">
      `,
      onSave: async () => {
        const payload = {
          name: document.getElementById('rule-name').value.trim(),
          field: document.getElementById('rule-field').value,
          op: document.getElementById('rule-op').value,
          value: document.getElementById('rule-value').value.trim() || null,
          points: parseInt(document.getElementById('rule-points').value, 10),
        };
        try {
          if (existing) await window.api.put('/sources/scoring/rules/' + existing.id, payload);
          else await window.api.post('/sources/scoring/rules', payload);
          window.modal = null; renderTab();
        } catch (e) { notify(e.message, 'error'); }
      },
    };
    window.render();
  }

  // ========================================================================
  // SEGMENTS
  // ========================================================================
  async function renderSegments(body) {
    S.segments = await window.api.get('/segments');
    body.innerHTML = `
      <div class="toolbar" style="margin-bottom:12px">
        <h3 style="margin:0">Segments</h3>
        <button class="btn btn-primary" onclick="Sources_newSegment()">+ New segment</button>
      </div>
      <p class="text-muted text-sm" style="margin:-4px 0 12px">Slice your leads with filters, then push a segment straight into a campaign. Dynamic segments update themselves as new leads arrive.</p>
      ${S.segments.length === 0 ? `<div class="empty" style="padding:36px;text-align:center"><p class="text-muted">No segments yet.</p></div>` : `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
          ${S.segments.map(segCard).join('')}
        </div>`}
    `;
    S.segments.forEach((seg) => refreshSegCount(seg.id));
  }

  function segCard(seg) {
    return `
      <div class="card" style="padding:16px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${esc(seg.name)}</strong>
          <span class="badge" style="background:var(--primary-light);color:var(--primary-hover)">${seg.kind}</span>
        </div>
        ${seg.description ? `<div class="text-muted text-sm">${esc(seg.description)}</div>` : ''}
        <div class="text-sm"><span id="segcount-${seg.id}" class="text-muted">counting…</span> leads</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
          <button class="btn btn-outline btn-sm" onclick="Sources_viewSegment(${seg.id})">View</button>
          <button class="btn btn-outline btn-sm" onclick="Sources_segToCampaign(${seg.id})">→ Campaign</button>
          ${seg.kind === 'dynamic' ? `<button class="btn btn-outline btn-sm" onclick="Sources_editSegment(${seg.id})">Edit filter</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="Sources_deleteSegment(${seg.id})" style="color:var(--danger)">Delete</button>
        </div>
      </div>`;
  }

  async function refreshSegCount(id) {
    try {
      const { count } = await window.api.get('/segments/' + id + '/count');
      const el = document.getElementById('segcount-' + id);
      if (el) { el.textContent = count; el.classList.remove('text-muted'); el.style.fontWeight = '700'; }
    } catch { /* ignore */ }
  }

  // A compact filter builder: rows of {field, op, value}, all ANDed. Covers the
  // common case; the full AND-of-ORs power is available via the API for later.
  function segmentModal(existing) {
    const fields = ['score', 'status', 'source_type', 'title', 'company', 'lead_type', 'confidence_score', 'has_email', 'has_phone', 'has_linkedin', 'created_at'];
    const conds = existing?.filter?.groups?.[0]?.conditions?.length ? existing.filter.groups[0].conditions : [{ field: 'score', op: 'gte', value: 60 }];

    const condRow = (c, i) => `
      <div class="seg-cond" style="display:grid;grid-template-columns:1.2fr 1fr 1.2fr auto;gap:6px;margin-bottom:6px">
        <select class="input seg-field">${fields.map((f) => `<option ${f === c.field ? 'selected' : ''}>${f}</option>`).join('')}</select>
        <select class="input seg-op">${['gte', 'lte', 'equals', 'contains', 'in', 'is_present', 'is_absent', 'in_last_days'].map((o) => `<option ${o === c.op ? 'selected' : ''}>${o}</option>`).join('')}</select>
        <input class="input seg-val" value="${esc(Array.isArray(c.value) ? c.value.join(',') : (c.value ?? ''))}" placeholder="value">
        <button class="btn btn-outline btn-sm" onclick="this.closest('.seg-cond').remove()">×</button>
      </div>`;

    window.modal = {
      title: existing ? 'Edit segment' : 'New segment',
      saveLabel: 'Save',
      body: `
        <label class="text-sm" style="font-weight:600">Name</label>
        <input id="seg-name" class="input" value="${esc(existing?.name || '')}" placeholder="e.g. Hot inbound this week" style="margin-bottom:12px">
        <label class="text-sm" style="font-weight:600;display:block;margin-bottom:6px">Match ALL of these conditions</label>
        <div id="seg-conds">${conds.map(condRow).join('')}</div>
        <button class="btn btn-outline btn-sm" onclick="Sources_addCond()">+ Condition</button>
        <div id="seg-preview" class="text-muted text-sm" style="margin-top:12px"></div>
      `,
      onSave: async () => {
        const payload = collectSegment();
        if (!payload.name) return notify('Name your segment', 'error');
        try {
          if (existing) await window.api.put('/segments/' + existing.id, { name: payload.name, filter: payload.filter });
          else await window.api.post('/segments', { name: payload.name, kind: 'dynamic', filter: payload.filter });
          window.modal = null; renderTab();
        } catch (e) { notify(e.message, 'error'); }
      },
    };
    window.render();
    // Wire a live preview after the modal DOM exists.
    setTimeout(() => { document.getElementById('seg-conds')?.addEventListener('change', previewSegment); previewSegment(); }, 50);
  }

  function collectSegment() {
    const name = document.getElementById('seg-name')?.value.trim() || '';
    const conditions = [...document.querySelectorAll('.seg-cond')].map((row) => {
      const field = row.querySelector('.seg-field').value;
      const op = row.querySelector('.seg-op').value;
      let value = row.querySelector('.seg-val').value.trim();
      if (op === 'in') value = value.split(',').map((v) => v.trim()).filter(Boolean);
      else if (op === 'gte' || op === 'lte' || op === 'in_last_days') value = Number(value);
      else if (op === 'is_present' || op === 'is_absent') value = null;
      return { field, op, value };
    });
    return { name, filter: { match: 'all', groups: [{ match: 'all', conditions }] } };
  }

  async function previewSegment() {
    const { filter } = collectSegment();
    const el = document.getElementById('seg-preview');
    if (!el) return;
    try {
      const res = await window.api.post('/segments/preview', { filter, limit: 3 });
      el.innerHTML = `Matches <strong>${res.total}</strong> leads` + (res.sample.length ? ` — e.g. ${res.sample.map((s) => esc(s.name)).join(', ')}` : '');
    } catch (e) { el.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
  }

  // ========================================================================
  // Actions (window-exposed for onclick)
  // ========================================================================
  window.loadSources = loadSources;
  window.Sources_reload = () => loadSources();
  window.Sources_tab = (t) => { S.tab = t; renderTab(); };

  window.Sources_connect = connect;
  window.Sources_view = viewSource;
  window.Sources_copy = (v) => { navigator.clipboard.writeText(v).then(() => notify('Copied', 'success'), () => {}); };
  window.Sources_toggle = async (id, status) => { try { await window.api.put('/sources/' + id, { status }); renderTab(); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_delete = async (id) => { if (!confirm('Delete this source? Leads already captured are kept.')) return; try { await window.api.delete('/sources/' + id); renderTab(); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_rotateSecret = async (id) => { try { const s = await window.api.post('/sources/' + id + '/rotate-secret', {}); showSetup(s); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_rotateKey = async (id) => { try { const s = await window.api.post('/sources/' + id + '/rotate-key', {}); showSetup(s); } catch (e) { notify(e.message, 'error'); } };

  window.Sources_inboxFilter = (st) => { S.inboxStatus = st; renderTab(); };
  window.Sources_accept = async (id) => { try { await window.api.post('/sources/inbox/' + id + '/accept', {}); await refreshCounts(); renderTab(); notify('Lead accepted', 'success'); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_reject = async (id) => { try { await window.api.post('/sources/inbox/' + id + '/reject', {}); await refreshCounts(); renderTab(); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_bulkInbox = async (action) => {
    const ids = S.inbox.map((r) => r.id);
    if (!ids.length) return;
    if (action === 'reject' && !confirm(`Reject ${ids.length} leads?`)) return;
    try { const r = await window.api.post('/sources/inbox/bulk', { ids, action }); await refreshCounts(); renderTab(); notify(`${action === 'accept' ? r.accepted + ' accepted' : r.rejected + ' rejected'}`, 'success'); } catch (e) { notify(e.message, 'error'); }
  };

  window.Sources_saveThresholds = async () => {
    try {
      await window.api.put('/sources/settings/lead', {
        auto_promote_threshold: parseInt(document.getElementById('thr-promote').value, 10),
        ai_qualify_threshold: parseInt(document.getElementById('thr-ai').value, 10),
        auto_create_deal: document.getElementById('thr-deal').checked,
      });
      notify('Thresholds saved', 'success');
    } catch (e) { notify(e.message, 'error'); }
  };
  window.Sources_addRule = () => ruleModal(null);
  window.Sources_editRule = (id) => ruleModal(S.rules.find((r) => r.id === id));
  window.Sources_toggleRule = async (id, enabled) => { const r = S.rules.find((x) => x.id === id); if (!r) return; try { await window.api.put('/sources/scoring/rules/' + id, { enabled }); r.enabled = enabled ? 1 : 0; } catch (e) { notify(e.message, 'error'); } };
  window.Sources_deleteRule = async (id) => { if (!confirm('Delete this rule?')) return; try { await window.api.delete('/sources/scoring/rules/' + id); renderTab(); } catch (e) { notify(e.message, 'error'); } };

  window.Sources_newSegment = () => segmentModal(null);
  window.Sources_editSegment = async (id) => { try { const seg = await window.api.get('/segments/' + id); segmentModal(seg); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_deleteSegment = async (id) => { if (!confirm('Delete this segment? Leads are not affected.')) return; try { await window.api.delete('/segments/' + id); renderTab(); } catch (e) { notify(e.message, 'error'); } };
  window.Sources_addCond = () => {
    const wrap = document.getElementById('seg-conds');
    if (!wrap) return;
    const div = document.createElement('div');
    div.innerHTML = `<div class="seg-cond" style="display:grid;grid-template-columns:1.2fr 1fr 1.2fr auto;gap:6px;margin-bottom:6px">
      <select class="input seg-field">${['score', 'status', 'source_type', 'title', 'company', 'lead_type', 'has_email', 'has_phone', 'has_linkedin', 'created_at'].map((f) => `<option>${f}</option>`).join('')}</select>
      <select class="input seg-op">${['gte', 'lte', 'equals', 'contains', 'in', 'is_present', 'is_absent', 'in_last_days'].map((o) => `<option>${o}</option>`).join('')}</select>
      <input class="input seg-val" placeholder="value">
      <button class="btn btn-outline btn-sm" onclick="this.closest('.seg-cond').remove()">×</button></div>`;
    wrap.appendChild(div.firstElementChild);
  };
  window.Sources_viewSegment = async (id) => {
    try {
      const members = await window.api.get('/segments/' + id + '/members?limit=100');
      window.modal = {
        title: 'Segment members',
        body: members.length ? `<div style="max-height:400px;overflow:auto"><table style="width:100%;font-size:13px"><thead><tr style="text-align:left;color:var(--text-muted)"><th>Name</th><th>Company</th><th>Score</th><th>Status</th></tr></thead><tbody>${members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.company || '')}</td><td>${m.score}</td><td>${esc(m.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="text-muted">No matching leads.</p>',
      };
      window.render();
    } catch (e) { notify(e.message, 'error'); }
  };
  window.Sources_segToCampaign = async (id) => {
    try {
      const campaigns = await window.api.get('/campaigns');
      if (!campaigns.length) return notify('Create a campaign first', 'error');
      window.modal = {
        title: 'Add segment to campaign',
        saveLabel: 'Add',
        body: `<label class="text-sm" style="font-weight:600">Campaign</label><select id="seg-camp" class="input">${campaigns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`,
        onSave: async () => {
          const campaign_id = parseInt(document.getElementById('seg-camp').value, 10);
          try { const r = await window.api.post('/segments/' + id + '/to-campaign', { campaign_id }); window.modal = null; window.render(); notify(`Added ${r.added} leads to the campaign`, 'success'); } catch (e) { notify(e.message, 'error'); }
        },
      };
      window.render();
    } catch (e) { notify(e.message, 'error'); }
  };
})();
