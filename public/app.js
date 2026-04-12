// ========== XSS Protection ==========
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ========== Auth State ==========
let authToken = sessionStorage.getItem('auth_token') || null;
let currentUser = null;

// ========== API Helper ==========
async function apiRequest(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const r = await fetch(`/api${url}`, { ...options, headers });
  if (r.status === 401) {
    authToken = null; currentUser = null;
    sessionStorage.removeItem('auth_token');
    render();
    throw new Error('Session expired. Please log in again.');
  }
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return data;
}

const api = {
  async get(url, headers = {}) { return apiRequest(url, { headers }); },
  async post(url, body, headers = {}) { return apiRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); },
  async put(url, body, headers = {}) { return apiRequest(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); },
  async del(url, headers = {}) { return apiRequest(url, { method: 'DELETE', headers }); },
};

// ========== State ==========
let currentPage = 'dashboard';
let modal = null;

// ========== Router ==========
function navigate(page) {
  currentPage = page;
  render();
}

// ========== Login ==========
function renderLoginPage() {
  return `
    <div style="max-width:400px;margin:100px auto;text-align:center">
      <h1 style="background:linear-gradient(135deg,#2ec4b6,#0e8b7d);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;font-size:28px">EIAAW SalesAgent</h1>
      <p class="text-muted" style="font-size:12px;margin-bottom:16px">AI-Human Sales Partnerships</p>
      <p class="text-muted mb-4">Sign in to your account</p>
      <div class="card">
        <div class="form-group"><label>Username</label><input id="login-user" placeholder="Username" onkeydown="if(event.key==='Enter')document.getElementById('login-pass').focus()"></div>
        <div class="form-group"><label>Password</label><input id="login-pass" type="password" placeholder="Password" onkeydown="if(event.key==='Enter')doLogin()"></div>
        <div id="login-error" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none"></div>
        <button class="btn btn-primary" style="width:100%" onclick="doLogin()">Sign In</button>
      </div>
    </div>
  `;
}

async function doLogin() {
  const username = document.getElementById('login-user')?.value;
  const password = document.getElementById('login-pass')?.value;
  const errEl = document.getElementById('login-error');
  try {
    const result = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then(r => r.json());
    if (result.error) throw new Error(result.error);

    authToken = result.token;
    currentUser = result.user;
    sessionStorage.setItem('auth_token', authToken);
    navigate('dashboard');
  } catch (e) {
    if (errEl) { errEl.style.display = 'block'; errEl.textContent = e.message; }
  }
}

function doLogout() {
  api.post('/auth/logout').catch(() => {});
  authToken = null; currentUser = null;
  sessionStorage.removeItem('auth_token');
  render();
}

// ========== Render Engine ==========
function render() {
  const app = document.getElementById('app');
  if (!authToken || !currentUser) {
    app.innerHTML = renderLoginPage();
    setTimeout(() => document.getElementById('login-user')?.focus(), 100);
    return;
  }
  app.innerHTML = `
    ${renderSidebar()}
    <div class="main">${renderPage()}</div>
    ${modal ? renderModal() : ''}
  `;
  afterRender();
}

function renderSidebar() {
  const isSuperadmin = currentUser?.role === 'superadmin';
  const items = [
    { id: 'dashboard', icon: '&#9632;', label: 'Dashboard' },
    { id: 'leads', icon: '&#9679;', label: 'Leads' },
    { id: 'pipeline', icon: '&#9654;', label: 'Pipeline' },
    { id: 'campaigns', icon: '&#9993;', label: 'Campaigns' },
    { id: 'content', icon: '&#9998;', label: 'AI Content' },
    { id: 'chat', icon: '&#10070;', label: 'AI Assistant' },
  ];

  if (isSuperadmin) {
    items.push({ id: 'settings', icon: '&#9881;', label: 'Settings' });
    items.push({ id: 'accounts', icon: '&#9775;', label: 'Accounts' });
    items.push({ id: 'system-overview', icon: '&#9881;', label: 'System Overview' });
    items.push({ id: 'system-logic', icon: '&#9883;', label: 'System Logic' });
  }

  return `
    <div class="sidebar">
      <div class="sidebar-logo">
        <h1>EIAAW SalesAgent</h1>
        <small>AI-Human Sales Partnerships</small>
      </div>
      ${items.map(i => `
        <div class="nav-item ${currentPage === i.id ? 'active' : ''}" onclick="navigate('${i.id}')">
          <span>${i.icon}</span> ${i.label}
        </div>
      `).join('')}
      <div style="position:absolute;bottom:0;left:0;right:0;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface)">
        <div class="text-sm" style="font-weight:600">${esc(currentUser?.displayName || currentUser?.username || '')}</div>
        <div class="text-muted text-sm">${currentUser?.role === 'superadmin' ? 'Super Admin' : `${(currentUser?.plan||'starter').toUpperCase()} Plan`}</div>
        <button class="btn btn-sm btn-outline" style="margin-top:8px;width:100%" onclick="doLogout()">Sign Out</button>
      </div>
    </div>
  `;
}

function renderPage() {
  switch (currentPage) {
    case 'dashboard': return '<div id="page" class="loading">Loading dashboard...</div>';
    case 'leads': return '<div id="page" class="loading">Loading leads...</div>';
    case 'pipeline': return '<div id="page" class="loading">Loading pipeline...</div>';
    case 'campaigns': return '<div id="page" class="loading">Loading campaigns...</div>';
    case 'content': return '<div id="page" class="loading">Loading content...</div>';
    case 'chat': return renderChatPage();
    case 'settings': return '<div id="page" class="loading">Loading settings...</div>';
    case 'accounts': return '<div id="page" class="loading">Loading accounts...</div>';
    case 'system-overview': return '<div id="page" class="loading">Loading overview...</div>';
    case 'system-logic': return '<div id="page" class="loading">Loading...</div>';
    default: return '<div>Page not found</div>';
  }
}

async function afterRender() {
  switch (currentPage) {
    case 'dashboard': return loadDashboard();
    case 'leads': return loadLeads();
    case 'pipeline': return loadPipeline();
    case 'campaigns': return loadCampaigns();
    case 'content': return loadContent();
    case 'settings': return loadSettings();
    case 'accounts': return loadAccounts();
    case 'system-overview': return loadSystemOverview();
    case 'system-logic': return loadSystemLogic();
  }
}

// ========== Dashboard ==========
async function loadDashboard() {
  try {
    const data = await api.get('/dashboard');
    document.getElementById('page').innerHTML = `
      <div class="toolbar"><h2>Dashboard</h2></div>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value blue">${data.leads.total}</div>
          <div class="stat-label">Total Leads</div>
        </div>
        <div class="stat-card">
          <div class="stat-value green">${data.leads.qualified}</div>
          <div class="stat-label">Qualified Leads</div>
        </div>
        <div class="stat-card">
          <div class="stat-value yellow">$${(data.deals.openValue || 0).toLocaleString()}</div>
          <div class="stat-label">Open Pipeline Value</div>
        </div>
        <div class="stat-card">
          <div class="stat-value purple">${data.campaigns.active}</div>
          <div class="stat-label">Active Campaigns</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h3>Top Leads by Score</h3>
          <table>
            <tr><th>Name</th><th>Company</th><th>Score</th><th>Status</th></tr>
            ${data.topLeads.map(l => `
              <tr>
                <td>${l.name}</td>
                <td>${l.company || '-'}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div class="score-bar" style="width:60px"><div class="score-fill" style="width:${l.score}%;background:${l.score > 70 ? 'var(--success)' : l.score > 40 ? 'var(--warning)' : 'var(--danger)'}"></div></div>
                    ${l.score}
                  </div>
                </td>
                <td><span class="badge badge-${l.status}">${l.status}</span></td>
              </tr>
            `).join('') || '<tr><td colspan="4" class="empty">No leads yet</td></tr>'}
          </table>
        </div>

        <div class="card">
          <h3>Recent Activity</h3>
          ${data.recentActivities.length ? data.recentActivities.map(a => `
            <div style="padding:8px 0;border-bottom:1px solid rgba(71,85,105,0.3);font-size:13px">
              <span class="badge badge-${a.type === 'ai_action' ? 'qualified' : 'contacted'}">${a.type}</span>
              <span style="margin-left:8px">${a.lead_name || ''} — ${a.description.substring(0, 80)}</span>
              <div class="text-muted text-sm" style="margin-top:2px">${new Date(a.created_at).toLocaleString()}</div>
            </div>
          `).join('') : '<div class="empty">No activities yet</div>'}
        </div>
      </div>

      <div class="card">
        <h3>Quick Actions</h3>
        <div class="flex gap-2" style="flex-wrap:wrap">
          <button class="btn btn-primary" onclick="navigate('leads')">Manage Leads</button>
          <button class="btn btn-outline" onclick="showGenerateModal('email')">Generate Email</button>
          <button class="btn btn-outline" onclick="showGenerateModal('social')">Generate Social Post</button>
          <button class="btn btn-outline" onclick="showGenerateModal('ad')">Generate Ad Copy</button>
          <button class="btn btn-outline" onclick="requestPipelineAnalysis()">Analyze Pipeline</button>
          <button class="btn btn-outline" onclick="navigate('chat')">Chat with AI</button>
        </div>
      </div>
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error loading dashboard: ${e.message}</div>`;
  }
}

// ========== Leads ==========
async function loadLeads() {
  try {
    const leads = await api.get('/leads');
    document.getElementById('page').innerHTML = `
      <div class="toolbar">
        <h2>Leads (${leads.length})</h2>
        <div class="flex gap-2">
          <button class="btn btn-primary" onclick="showLeadModal()">+ Add Lead</button>
          <button class="btn btn-outline" onclick="showBulkImportModal()">Import CSV</button>
        </div>
      </div>
      <div class="card">
        <table>
          <tr><th>Name</th><th>Email</th><th>Company</th><th>Source</th><th>Score</th><th>Status</th><th>Performance</th><th>Actions</th></tr>
          ${leads.map(l => `
            <tr>
              <td><strong>${l.name}</strong></td>
              <td>${l.email}</td>
              <td>${l.company || '-'}</td>
              <td>${l.source}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <div class="score-bar" style="width:50px"><div class="score-fill" style="width:${l.score}%;background:${l.score > 70 ? 'var(--success)' : l.score > 40 ? 'var(--warning)' : 'var(--danger)'}"></div></div>
                  ${l.score}
                </div>
              </td>
              <td><span class="badge badge-${l.status}">${l.status}</span></td>
              <td>
                <span style="color:${l.open_count > 0 ? 'var(--success)' : 'var(--text-muted)'}">${l.open_count || 0} open${l.open_count !== 1 ? 's' : ''}</span>,
                <span style="color:${l.click_count > 0 ? 'var(--primary)' : 'var(--text-muted)'}">${l.click_count || 0} click${l.click_count !== 1 ? 's' : ''}</span>
              </td>
              <td>
                <div class="flex gap-2">
                  <button class="btn btn-sm btn-outline" onclick="aiScoreLead(${l.id})">AI Score</button>
                  <button class="btn btn-sm btn-outline" onclick="aiQualifyLead(${l.id})">Qualify</button>
                  <button class="btn btn-sm btn-outline" onclick="aiOutreach(${l.id})">Outreach</button>
                  <button class="btn btn-sm btn-outline" onclick="showLeadModal(${l.id})">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteLead(${l.id})">X</button>
                </div>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="8" class="empty">No leads yet. Add your first lead!</td></tr>'}
        </table>
      </div>
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

async function showLeadModal(id) {
  let lead = { name: '', email: '', company: '', title: '', phone: '', source: 'manual', notes: '' };
  if (id) {
    lead = await api.get(`/leads/${id}`);
  }

  modal = {
    title: id ? 'Edit Lead' : 'Add Lead',
    body: `
      <div class="form-group"><label>Name *</label><input id="f-name" value="${lead.name}"></div>
      <div class="form-group"><label>Email *</label><input id="f-email" type="email" value="${lead.email}"></div>
      <div class="grid-2">
        <div class="form-group"><label>Company</label><input id="f-company" value="${lead.company || ''}"></div>
        <div class="form-group"><label>Title</label><input id="f-title" value="${lead.title || ''}"></div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label>Phone</label><input id="f-phone" value="${lead.phone || ''}"></div>
        <div class="form-group"><label>Source</label>
          <select id="f-source">
            ${['manual','website','linkedin','referral','ad','event','cold_outreach'].map(s => `<option value="${s}" ${lead.source === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group"><label>Notes</label><textarea id="f-notes">${lead.notes || ''}</textarea></div>
    `,
    onSave: async () => {
      const data = {
        name: document.getElementById('f-name').value,
        email: document.getElementById('f-email').value,
        company: document.getElementById('f-company').value,
        title: document.getElementById('f-title').value,
        phone: document.getElementById('f-phone').value,
        source: document.getElementById('f-source').value,
        notes: document.getElementById('f-notes').value,
      };
      if (id) await api.put(`/leads/${id}`, data);
      else await api.post('/leads', data);
      modal = null;
      navigate('leads');
    },
  };
  render();
}

async function deleteLead(id) {
  if (!confirm('Delete this lead?')) return;
  await api.del(`/leads/${id}`);
  loadLeads();
}

async function aiScoreLead(id) {
  showNotification('Scoring lead with AI...');
  try {
    const result = await api.post(`/leads/${id}/score`);
    showResultModal('AI Lead Score', `
      <div class="stat-card mb-4">
        <div class="stat-value ${result.score > 70 ? 'green' : result.score > 40 ? 'yellow' : ''}">${result.score}/100</div>
        <div class="stat-label">Lead Score</div>
      </div>
      <p><strong>Reasoning:</strong> ${result.reasoning}</p>
      <p style="margin-top:8px"><strong>Recommended Action:</strong> ${result.recommended_action}</p>
    `);
    loadLeads();
  } catch (e) { showNotification('Error: ' + e.message, 'error'); }
}

async function aiQualifyLead(id) {
  showNotification('Qualifying lead with AI...');
  try {
    const result = await api.post(`/leads/${id}/qualify`);
    showResultModal('AI Lead Qualification', `
      <div class="stat-card mb-4">
        <div class="stat-value ${result.qualified ? 'green' : 'yellow'}">${result.qualified ? 'QUALIFIED' : 'NOT YET QUALIFIED'}</div>
        <div class="stat-label">BANT Score: ${result.total_score}/100</div>
      </div>
      <div class="grid-2 mb-4">
        <div>Budget: ${result.bant_score?.budget || 0}/25</div>
        <div>Authority: ${result.bant_score?.authority || 0}/25</div>
        <div>Need: ${result.bant_score?.need || 0}/25</div>
        <div>Timeline: ${result.bant_score?.timeline || 0}/25</div>
      </div>
      <p><strong>Notes:</strong> ${result.qualification_notes}</p>
      <p style="margin-top:8px"><strong>Next Steps:</strong></p>
      <ul>${(result.next_steps || []).map(s => `<li>${s}</li>`).join('')}</ul>
    `);
    loadLeads();
  } catch (e) { showNotification('Error: ' + e.message, 'error'); }
}

async function aiOutreach(id) {
  showNotification('Generating outreach sequence...');
  try {
    const result = await api.post(`/leads/${id}/outreach`, {
      valueProposition: 'We help businesses automate their sales and marketing with AI.',
    });
    showResultModal('AI Outreach Sequence', `
      ${(result.sequence || []).map(s => `
        <div class="content-card">
          <div class="type">Step ${s.step} — ${s.channel} (Day ${s.delay_days})</div>
          ${s.subject ? `<div><strong>Subject:</strong> ${s.subject}</div>` : ''}
          <pre>${s.message}</pre>
          <div class="text-muted text-sm">Goal: ${s.goal}</div>
        </div>
      `).join('')}
    `);
  } catch (e) { showNotification('Error: ' + e.message, 'error'); }
}

// ========== Pipeline ==========
async function loadPipeline() {
  try {
    const [deals, stats] = await Promise.all([api.get('/pipeline'), api.get('/pipeline/stats')]);
    const stages = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

    document.getElementById('page').innerHTML = `
      <div class="toolbar">
        <h2>Sales Pipeline</h2>
        <div class="flex gap-2">
          <button class="btn btn-primary" onclick="showDealModal()">+ Add Deal</button>
          <button class="btn btn-outline" onclick="requestPipelineAnalysis()">AI Analysis</button>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value blue">${stats.open?.count || 0}</div>
          <div class="stat-label">Open Deals</div>
        </div>
        <div class="stat-card">
          <div class="stat-value yellow">$${(stats.open?.total_value || 0).toLocaleString()}</div>
          <div class="stat-label">Open Value</div>
        </div>
        <div class="stat-card">
          <div class="stat-value green">$${(stats.weightedPipelineValue || 0).toLocaleString()}</div>
          <div class="stat-label">Weighted Pipeline</div>
        </div>
        <div class="stat-card">
          <div class="stat-value purple">${stats.winRate || 0}%</div>
          <div class="stat-label">Win Rate</div>
        </div>
      </div>

      <div class="pipeline-board">
        ${stages.map(stage => {
          const stageDeals = deals.filter(d => d.stage === stage);
          const total = stageDeals.reduce((s, d) => s + d.deal_value, 0);
          return `
            <div class="pipeline-column">
              <h4>
                <span>${stage.replace(/_/g, ' ')}</span>
                <span>$${total.toLocaleString()}</span>
              </h4>
              ${stageDeals.map(d => `
                <div class="pipeline-card" onclick="showDealModal(${d.id})">
                  <div class="name">${d.name}</div>
                  <div class="company">${d.company || ''}</div>
                  <div class="value">$${d.deal_value.toLocaleString()}</div>
                  <div class="text-muted text-sm">${d.probability}% probability</div>
                </div>
              `).join('') || '<div class="text-muted text-sm" style="text-align:center">No deals</div>'}
            </div>
          `;
        }).join('')}
      </div>
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

async function showDealModal(id) {
  let deal = { lead_id: '', stage: 'prospecting', deal_value: 0, probability: 10, expected_close_date: '', notes: '' };
  if (id) deal = await api.get(`/pipeline/${id}`);

  const leads = await api.get('/leads');

  modal = {
    title: id ? 'Edit Deal' : 'New Deal',
    body: `
      <div class="form-group"><label>Lead</label>
        <select id="f-lead">${leads.map(l => `<option value="${l.id}" ${deal.lead_id == l.id ? 'selected' : ''}>${l.name} (${l.company || l.email})</option>`).join('')}</select>
      </div>
      <div class="form-group"><label>Stage</label>
        <select id="f-stage">${['prospecting','qualification','proposal','negotiation','closed_won','closed_lost'].map(s => `<option value="${s}" ${deal.stage === s ? 'selected' : ''}>${s.replace('_',' ')}</option>`).join('')}</select>
      </div>
      <div class="grid-2">
        <div class="form-group"><label>Deal Value ($)</label><input id="f-value" type="number" value="${deal.deal_value}"></div>
        <div class="form-group"><label>Probability (%)</label><input id="f-prob" type="number" min="0" max="100" value="${deal.probability}"></div>
      </div>
      <div class="form-group"><label>Expected Close Date</label><input id="f-close" type="date" value="${deal.expected_close_date || ''}"></div>
      <div class="form-group"><label>Notes</label><textarea id="f-notes">${deal.notes || ''}</textarea></div>
    `,
    onSave: async () => {
      const data = {
        lead_id: parseInt(document.getElementById('f-lead').value),
        stage: document.getElementById('f-stage').value,
        deal_value: parseFloat(document.getElementById('f-value').value),
        probability: parseInt(document.getElementById('f-prob').value),
        expected_close_date: document.getElementById('f-close').value,
        notes: document.getElementById('f-notes').value,
      };
      if (id) await api.put(`/pipeline/${id}`, data);
      else await api.post('/pipeline', data);
      modal = null;
      navigate('pipeline');
    },
  };
  render();
}

async function requestPipelineAnalysis() {
  showNotification('Running AI pipeline analysis...');
  try {
    const result = await api.post('/pipeline/analyze');
    const a = result.analysis;
    showResultModal('AI Pipeline Analysis', `
      <div class="stat-card mb-4">
        <div class="stat-value ${a.health_score > 70 ? 'green' : a.health_score > 40 ? 'yellow' : ''}">${a.health_score}/100</div>
        <div class="stat-label">Pipeline Health Score</div>
      </div>
      <h4>Revenue Forecast</h4>
      <div class="grid-2 mb-4" style="grid-template-columns:1fr 1fr 1fr">
        <div class="stat-card"><div class="stat-value green text-sm">$${(a.forecast?.optimistic || 0).toLocaleString()}</div><div class="stat-label">Optimistic</div></div>
        <div class="stat-card"><div class="stat-value blue text-sm">$${(a.forecast?.realistic || 0).toLocaleString()}</div><div class="stat-label">Realistic</div></div>
        <div class="stat-card"><div class="stat-value yellow text-sm">$${(a.forecast?.pessimistic || 0).toLocaleString()}</div><div class="stat-label">Pessimistic</div></div>
      </div>
      <h4>Bottlenecks</h4>
      <ul>${(a.bottlenecks || []).map(b => `<li>${b}</li>`).join('')}</ul>
      <h4 style="margin-top:12px">Recommendations</h4>
      <ul>${(a.recommendations || []).map(r => `<li>${r}</li>`).join('')}</ul>
    `);
  } catch (e) { showNotification('Error: ' + e.message, 'error'); }
}

// ========== Campaigns ==========
let wizardState = null; // holds wizard data when active

async function loadCampaigns() {
  // If wizard is active, render the wizard instead
  if (wizardState) { renderCampaignWizard(); return; }

  try {
    const [campaigns, costData] = await Promise.all([
      api.get('/campaigns'),
      api.get('/campaigns/ai-costs').catch(() => ({ overall: { total_cost: 0, total_tokens: 0, call_count: 0 }, byCampaign: [] })),
    ]);

    // Map cost data by campaign id
    const costMap = {};
    (costData.byCampaign || []).forEach(c => { costMap[c.id] = c; });

    document.getElementById('page').innerHTML = `
      <div class="toolbar">
        <h2>Campaigns (${campaigns.length})</h2>
        <button class="btn btn-primary" onclick="startCampaignWizard()">+ New Campaign</button>
      </div>

      ${campaigns.length > 0 ? `
        <!-- AI Cost Overview -->
        <div class="stats-grid" style="margin-bottom:16px">
          <div class="stat-card">
            <div class="stat-value blue">${costData.overall.call_count}</div>
            <div class="stat-label">Total AI Calls</div>
          </div>
          <div class="stat-card">
            <div class="stat-value yellow">$${costData.overall.total_cost.toFixed(4)}</div>
            <div class="stat-label">Total AI Cost</div>
          </div>
          <div class="stat-card">
            <div class="stat-value purple">${(costData.overall.total_tokens / 1000).toFixed(1)}k</div>
            <div class="stat-label">Total Tokens Used</div>
          </div>
          <div class="stat-card">
            <div class="stat-value green">${campaigns.length}</div>
            <div class="stat-label">Active Campaigns</div>
          </div>
        </div>
      ` : ''}

      ${campaigns.length === 0 ? `
        <div class="card" style="text-align:center;padding:60px 20px">
          <div style="font-size:48px;margin-bottom:16px">&#9993;</div>
          <h3 style="color:var(--text);font-size:18px;margin-bottom:8px;text-transform:none;letter-spacing:0">Create Your First Campaign</h3>
          <p class="text-muted mb-4">We'll guide you through it step by step — it only takes a minute.</p>
          <button class="btn btn-primary" onclick="startCampaignWizard()" style="font-size:15px;padding:12px 24px">Get Started</button>
        </div>
      ` : campaigns.map(c => {
        const cost = costMap[c.id] || { total_cost: 0, total_tokens: 0, call_count: 0, budget_limit: 0 };
        const budgetPct = cost.budget_limit > 0 ? Math.min((cost.total_cost / cost.budget_limit) * 100, 100) : 0;
        const overBudget = cost.budget_limit > 0 && cost.total_cost >= cost.budget_limit;
        return `
        <div class="camp-card" id="camp-${c.id}">
          <div class="camp-header" onclick="toggleCampaignLeads(${c.id})">
            <div class="camp-info">
              <div class="camp-title">
                <strong>${c.name}</strong>
                <span class="badge badge-${c.status}">${c.status}</span>
                <span class="badge badge-new">${c.type}</span>
              </div>
              <div class="camp-meta text-muted text-sm">
                ${c.target_audience ? `Target: ${c.target_audience}` : 'No target audience set'}
                &nbsp;&middot;&nbsp; Sent: ${c.sent_count} &nbsp;&middot;&nbsp; Opens: ${c.open_count} &nbsp;&middot;&nbsp; Clicks: ${c.click_count}
              </div>
              <!-- Cost bar -->
              <div class="camp-cost-row">
                <span class="text-sm">AI Cost: <strong${overBudget ? ' style="color:var(--danger)"' : ''}>$${cost.total_cost.toFixed(4)}</strong>${cost.budget_limit > 0 ? ` / $${cost.budget_limit.toFixed(2)}` : ''}</span>
                <span class="text-sm text-muted">${cost.call_count} calls &middot; ${(cost.total_tokens / 1000).toFixed(1)}k tokens</span>
                <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); showBudgetModal(${c.id}, ${cost.budget_limit || 0})" style="padding:2px 8px;font-size:11px">
                  ${cost.budget_limit > 0 ? 'Edit Budget' : 'Set Budget'}
                </button>
              </div>
              ${cost.budget_limit > 0 ? `
                <div class="camp-budget-bar">
                  <div class="camp-budget-fill ${overBudget ? 'over' : ''}" style="width:${budgetPct}%"></div>
                </div>
              ` : ''}
            </div>
            <div class="camp-actions flex gap-2" onclick="event.stopPropagation()">
              <button class="btn btn-sm btn-primary" onclick="aiGenerateLeads(${c.id})" title="AI finds leads matching your target audience">
                Auto-Find Leads
              </button>
              <button class="btn btn-sm btn-success" onclick="aiAutoOutreach(${c.id})" title="AI creates personalized outreach for every lead and sends Step 1">
                Auto-Outreach
              </button>
              <button class="btn btn-sm btn-outline" onclick="startCampaignWizard(${c.id})">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="deleteCampaign(${c.id})">X</button>
              <span class="camp-toggle" id="camp-toggle-${c.id}">&#9660;</span>
            </div>
          </div>
          <div class="camp-leads" id="camp-leads-${c.id}" style="display:none">
            <div class="loading text-sm">Click to load leads...</div>
          </div>
        </div>
      `; }).join('')}
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

// Budget modal
function showBudgetModal(campaignId, currentBudget) {
  modal = {
    title: 'Set AI Budget Limit',
    body: `
      <p class="text-muted text-sm mb-4">Set a maximum AI spending limit for this campaign. When the limit is reached, AI features will be paused for this campaign.</p>
      <div class="form-group">
        <label>Budget Limit (USD)</label>
        <input id="f-budget" type="number" step="0.01" min="0" value="${currentBudget || ''}" placeholder="e.g. 1.00 — leave empty or 0 for unlimited">
        <small class="text-muted">$0.003–0.01 per typical AI call (scoring, content generation, etc.)</small>
      </div>
    `,
    onSave: async () => {
      const budget = parseFloat(document.getElementById('f-budget').value) || 0;
      await api.put(`/campaigns/${campaignId}/budget`, { budget_limit: budget });
      modal = null;
      showNotification(budget > 0 ? `Budget set to $${budget.toFixed(2)}` : 'Budget limit removed', 'success');
      navigate('campaigns');
    },
  };
  render();
}

// Toggle campaign leads panel
async function toggleCampaignLeads(id) {
  const panel = document.getElementById(`camp-leads-${id}`);
  const toggle = document.getElementById(`camp-toggle-${id}`);
  if (!panel) return;

  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (toggle) toggle.innerHTML = isHidden ? '&#9650;' : '&#9660;';

  if (isHidden) {
    panel.innerHTML = '<div class="loading text-sm" style="padding:16px">Loading...</div>';
    try {
      const [campaign, outreachQueue] = await Promise.all([
        api.get(`/campaigns/${id}`),
        api.get(`/campaigns/${id}/outreach-queue`).catch(() => []),
      ]);
      const leads = campaign.leads || [];

      // Count outreach stats
      const outreachSent = outreachQueue.filter(q => q.status === 'sent').length;
      const outreachPending = outreachQueue.filter(q => q.status === 'pending').length;
      const leadsWithOutreach = new Set(outreachQueue.map(q => q.lead_id)).size;

      panel.innerHTML = `
        <div style="padding:12px 16px;border-top:1px solid var(--border)">
          <!-- Leads Section -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <span class="text-sm"><strong>${leads.length}</strong> leads assigned</span>
            <div class="flex gap-2">
              <button class="btn btn-sm btn-primary" onclick="aiGenerateLeads(${id})">+ Find More Leads</button>
              ${leads.length > 0 ? `<button class="btn btn-sm btn-success" onclick="aiAutoOutreach(${id})">Auto-Outreach All</button>` : ''}
            </div>
          </div>
          ${leads.length > 0 ? `
            <table style="font-size:13px">
              <tr><th>Name</th><th>Email</th><th>Company</th><th>Source</th><th>Score</th><th>Status</th><th>Performance</th></tr>
              ${leads.map(l => {
                const cs = l.campaign_status || 'pending';
                const opened = ['opened','clicked','replied'].includes(cs) ? 1 : 0;
                const clicked = ['clicked','replied'].includes(cs) ? 1 : 0;
                return `
                <tr>
                  <td><strong>${l.name}</strong></td>
                  <td>${l.email}</td>
                  <td>${l.company || '-'}</td>
                  <td>${l.source === 'ai_generated' ? '<span class="badge badge-new">AI Found</span>' : l.source}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px">
                      <div class="score-bar" style="width:40px"><div class="score-fill" style="width:${l.score}%;background:${l.score > 70 ? 'var(--success)' : l.score > 40 ? 'var(--warning)' : 'var(--danger)'}"></div></div>
                      ${l.score}
                    </div>
                  </td>
                  <td><span class="badge badge-${cs}">${cs}</span></td>
                  <td>
                    <span style="color:${opened ? 'var(--success)' : 'var(--text-muted)'}">${opened} open${opened !== 1 ? 's' : ''}</span>,
                    <span style="color:${clicked ? 'var(--primary)' : 'var(--text-muted)'}">${clicked} click${clicked !== 1 ? 's' : ''}</span>
                  </td>
                </tr>
              `; }).join('')}
            </table>
          ` : `
            <div class="empty text-sm" style="padding:20px">
              No leads yet. Click <strong>Find More Leads</strong> to let AI find matching leads.
            </div>
          `}

          ${outreachQueue.length > 0 ? `
            <!-- Outreach Section -->
            <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <span class="text-sm">
                  <strong>Outreach:</strong>
                  <span class="badge badge-active">${outreachSent} sent</span>
                  <span class="badge badge-draft">${outreachPending} pending</span>
                  &nbsp;for ${leadsWithOutreach} leads
                </span>
                <button class="btn btn-sm btn-outline" onclick="showOutreachQueue(${id})">View Full Queue</button>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    } catch (e) {
      panel.innerHTML = `<div class="empty text-sm" style="padding:16px">Error: ${e.message}</div>`;
    }
  }
}

// AI auto-generate leads for a campaign
async function aiGenerateLeads(campaignId) {
  const countStr = prompt('How many leads should AI find? (1-15)', '5');
  if (!countStr) return;
  const count = Math.min(Math.max(parseInt(countStr) || 5, 1), 15);

  showNotification(`AI is finding ${count} leads for your campaign...`);

  try {
    const result = await api.post(`/campaigns/${campaignId}/generate-leads`, { count });
    showNotification(`Found ${result.generated} new leads!`, 'success');

    // Refresh the leads panel if open
    const panel = document.getElementById(`camp-leads-${campaignId}`);
    if (panel && panel.style.display !== 'none') {
      toggleCampaignLeads(campaignId); // close
      toggleCampaignLeads(campaignId); // reopen to refresh
    }

    // Also refresh leads page if visible
    if (currentPage === 'leads') loadLeads();
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
  }
}

// AI Auto-Outreach
async function aiAutoOutreach(campaignId) {
  if (!confirm('AI will generate a personalized outreach sequence for every lead in this campaign and send Step 1 immediately.\n\nContinue?')) return;

  showNotification('AI is generating outreach sequences for all leads...');

  try {
    const result = await api.post(`/campaigns/${campaignId}/auto-outreach`);
    showNotification(
      `Outreach started! ${result.leadsProcessed} leads, ${result.totalSteps} steps queued, ${result.immediatelySent} Step 1 messages sent.`,
      'success'
    );

    // Refresh panel if open
    const panel = document.getElementById(`camp-leads-${campaignId}`);
    if (panel && panel.style.display !== 'none') {
      toggleCampaignLeads(campaignId);
      toggleCampaignLeads(campaignId);
    }
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
  }
}

// View outreach queue for a campaign
async function showOutreachQueue(campaignId) {
  showNotification('Loading outreach queue...');
  try {
    const queue = await api.get(`/campaigns/${campaignId}/outreach-queue`);

    if (!queue.length) {
      showNotification('No outreach queued yet. Click Auto-Outreach first.', 'error');
      return;
    }

    // Group by lead
    const byLead = {};
    for (const item of queue) {
      if (!byLead[item.lead_id]) byLead[item.lead_id] = { name: item.lead_name, email: item.lead_email, company: item.lead_company, steps: [] };
      byLead[item.lead_id].steps.push(item);
    }

    const body = Object.values(byLead).map(lead => `
      <div class="content-card" style="margin-bottom:12px">
        <div class="type" style="margin-bottom:8px">${lead.name} — ${lead.company || lead.email}</div>
        ${lead.steps.map(s => `
          <div class="outreach-step ${s.status}">
            <div class="outreach-step-header">
              <span class="outreach-step-num">${s.step}</span>
              <span class="badge badge-${s.status === 'sent' ? 'active' : s.status === 'pending' ? 'draft' : 'paused'}">${s.status}</span>
              <span class="text-sm">${s.channel}</span>
              <span class="text-muted text-sm">${s.delay_days === 0 ? 'Immediate' : `Day ${s.delay_days}`}</span>
            </div>
            ${s.subject ? `<div class="text-sm" style="margin:4px 0"><strong>Subject:</strong> ${s.subject}</div>` : ''}
            <div class="text-sm" style="color:var(--text-muted);line-height:1.5">${s.message.substring(0, 200)}${s.message.length > 200 ? '...' : ''}</div>
            ${s.goal ? `<div class="text-sm" style="margin-top:4px;color:var(--primary)">Goal: ${s.goal}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('');

    modal = {
      title: `Outreach Queue (${queue.length} steps for ${Object.keys(byLead).length} leads)`,
      body: `<div style="max-height:60vh;overflow-y:auto">${body}</div>`,
    };
    render();
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
  }
}

// ===== Campaign Wizard =====
const WIZARD_STEPS = [
  { id: 'basics', label: 'Basic Info', icon: '&#9998;' },
  { id: 'content', label: 'Content', icon: '&#9993;' },
  { id: 'leads', label: 'Assign Leads', icon: '&#9679;' },
  { id: 'review', label: 'Review & Launch', icon: '&#9654;' },
];

async function startCampaignWizard(editId) {
  let campaign = { name: '', type: 'email', subject: '', body: '', target_audience: '' };
  let assignedLeadIds = [];

  if (editId) {
    campaign = await api.get(`/campaigns/${editId}`);
    assignedLeadIds = (campaign.leads || []).map(l => l.id);
  }

  wizardState = {
    editId: editId || null,
    step: 0,
    data: {
      name: campaign.name,
      type: campaign.type,
      subject: campaign.subject || '',
      body: campaign.body || '',
      target_audience: campaign.target_audience || '',
      budget_limit: campaign.budget_limit || 0,
    },
    selectedLeads: assignedLeadIds,
    allLeads: [],
  };

  renderCampaignWizard();
}

function renderCampaignWizard() {
  const page = document.getElementById('page');
  if (!page) return;

  const s = wizardState;
  const step = WIZARD_STEPS[s.step];

  page.innerHTML = `
    <div class="toolbar">
      <h2>${s.editId ? 'Edit Campaign' : 'New Campaign'}</h2>
      <button class="btn btn-outline" onclick="exitCampaignWizard()">Cancel</button>
    </div>

    <!-- Progress Steps -->
    <div class="wizard-progress">
      ${WIZARD_STEPS.map((ws, i) => `
        <div class="wizard-step ${i < s.step ? 'completed' : ''} ${i === s.step ? 'active' : ''}" onclick="${i < s.step ? `wizardGoTo(${i})` : ''}">
          <div class="wizard-step-circle">${i < s.step ? '&#10003;' : i + 1}</div>
          <div class="wizard-step-label">${ws.label}</div>
        </div>
        ${i < WIZARD_STEPS.length - 1 ? '<div class="wizard-step-line ' + (i < s.step ? 'completed' : '') + '"></div>' : ''}
      `).join('')}
    </div>

    <!-- Step Content -->
    <div class="card wizard-card">
      <div class="wizard-step-header">
        <span class="wizard-step-icon">${step.icon}</span>
        <div>
          <h3 style="color:var(--text);text-transform:none;letter-spacing:0;font-size:16px;margin-bottom:2px">Step ${s.step + 1}: ${step.label}</h3>
          <p class="text-muted text-sm">${getStepDescription(s.step)}</p>
        </div>
      </div>
      <div class="wizard-step-body" id="wizard-body">
        ${renderWizardStepContent(s.step)}
      </div>
    </div>

    <!-- Navigation -->
    <div class="wizard-nav">
      <div>
        ${s.step > 0 ? `<button class="btn btn-outline" onclick="wizardBack()">Back</button>` : ''}
      </div>
      <div class="flex gap-2">
        ${s.step === 2 ? `<button class="btn btn-outline" onclick="wizardNext()">Skip — I'll add leads later</button>` : ''}
        ${s.step < WIZARD_STEPS.length - 1 ? `
          <button class="btn btn-primary" onclick="wizardNext()" id="wizard-next-btn">
            Next: ${WIZARD_STEPS[s.step + 1].label} &#8594;
          </button>
        ` : ''}
        ${s.step === WIZARD_STEPS.length - 1 ? `
          <button class="btn btn-outline" onclick="wizardSave('draft')">Save as Draft</button>
          ${wizardState.data.type === 'email' && wizardState.selectedLeads.length > 0 ? `
            <button class="btn btn-success" onclick="wizardSave('send')">Save & Send Now</button>
          ` : `
            <button class="btn btn-primary" onclick="wizardSave('draft')">Save Campaign</button>
          `}
        ` : ''}
      </div>
    </div>
  `;

  // Load leads data if on step 2
  if (s.step === 2 && s.allLeads.length === 0) {
    loadWizardLeads();
  }
}

function getStepDescription(step) {
  switch (step) {
    case 0: return 'Give your campaign a name and choose what type it is.';
    case 1: return 'Write your message or let AI generate it for you.';
    case 2: return 'Choose which leads will receive this campaign.';
    case 3: return 'Review everything and launch when ready.';
  }
}

function renderWizardStepContent(step) {
  const d = wizardState.data;

  switch (step) {
    case 0: return `
      <div class="form-group">
        <label>Campaign Name *</label>
        <input id="wz-name" value="${d.name}" placeholder="e.g. Q2 Product Launch, Welcome Series..."
          oninput="wizardState.data.name=this.value">
        <small class="text-muted">Pick a name that helps you remember what this campaign is about.</small>
      </div>
      <div class="form-group">
        <label>Campaign Type *</label>
        <div class="wizard-type-grid">
          ${[
            { val: 'email', icon: '&#9993;', title: 'Email', desc: 'Send emails to your leads' },
            { val: 'social', icon: '&#128172;', title: 'Social Media', desc: 'Create social media posts' },
            { val: 'content', icon: '&#9998;', title: 'Content', desc: 'Blog posts, articles, etc.' },
            { val: 'ad', icon: '&#128226;', title: 'Advertisement', desc: 'Paid ads on platforms' },
          ].map(t => `
            <div class="wizard-type-card ${d.type === t.val ? 'selected' : ''}"
              onclick="wizardState.data.type='${t.val}'; renderCampaignWizard();">
              <div class="wizard-type-icon">${t.icon}</div>
              <div class="wizard-type-title">${t.title}</div>
              <div class="wizard-type-desc">${t.desc}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>Target Audience</label>
        <input id="wz-audience" value="${d.target_audience}" placeholder="e.g. SaaS founders, enterprise CTOs, new signups..."
          oninput="wizardState.data.target_audience=this.value">
        <small class="text-muted">Describe who this campaign is for. This helps AI generate better content.</small>
      </div>
      <div class="form-group">
        <label>AI Budget Limit (USD) — optional</label>
        <input id="wz-budget" type="number" step="0.01" min="0" value="${d.budget_limit || ''}" placeholder="e.g. 1.00 — leave empty for no limit"
          oninput="wizardState.data.budget_limit=parseFloat(this.value)||0">
        <small class="text-muted">Set a spending cap for AI features on this campaign. AI calls cost ~$0.003–0.01 each.</small>
      </div>
    `;

    case 1:
      const isEmail = d.type === 'email';
      return `
        ${isEmail ? `
          <div class="form-group">
            <label>Email Subject Line</label>
            <input id="wz-subject" value="${d.subject}" placeholder="e.g. Introducing our new AI-powered features..."
              oninput="wizardState.data.subject=this.value">
            <small class="text-muted">A compelling subject line increases your open rate.</small>
          </div>
        ` : ''}
        <div class="form-group">
          <label>${isEmail ? 'Email Body' : d.type === 'social' ? 'Post Content' : d.type === 'ad' ? 'Ad Copy' : 'Content'}</label>
          <textarea id="wz-body" style="min-height:180px" placeholder="${getContentPlaceholder(d.type)}"
            oninput="wizardState.data.body=this.value">${d.body}</textarea>
        </div>
        <div class="wizard-ai-box">
          <div style="flex:1">
            <strong>Need help writing?</strong>
            <p class="text-muted text-sm">Let AI generate ${isEmail ? 'an email' : 'content'} based on your campaign details.</p>
          </div>
          <button class="btn btn-primary" onclick="wizardAiGenerate()" id="wz-ai-btn">Generate with AI</button>
        </div>
      `;

    case 2: return `
      <div id="wz-leads-container">
        <div class="loading">Loading leads...</div>
      </div>
    `;

    case 3: return renderWizardReview();
  }
}

function getContentPlaceholder(type) {
  switch (type) {
    case 'email': return 'Write your email content here... or use AI to generate it.';
    case 'social': return 'Write your social media post here...';
    case 'ad': return 'Write your ad copy here...';
    case 'content': return 'Write your content here...';
  }
}

async function loadWizardLeads() {
  try {
    const leads = await api.get('/leads');
    wizardState.allLeads = leads;
    const container = document.getElementById('wz-leads-container');
    if (!container) return;

    if (leads.length === 0) {
      container.innerHTML = `
        <div class="empty" style="padding:30px">
          <p>No leads found. You can add leads from the Leads page.</p>
          <button class="btn btn-outline" onclick="exitCampaignWizard(); navigate('leads')" style="margin-top:12px">Go to Leads</button>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <strong id="wz-lead-count">${wizardState.selectedLeads.length}</strong> of ${leads.length} leads selected
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-outline" onclick="wizardSelectAllLeads()">Select All</button>
          <button class="btn btn-sm btn-outline" onclick="wizardDeselectAllLeads()">Deselect All</button>
        </div>
      </div>
      <div class="wizard-leads-list">
        ${leads.map(l => `
          <label class="wizard-lead-item ${wizardState.selectedLeads.includes(l.id) ? 'selected' : ''}" id="wz-lead-${l.id}">
            <input type="checkbox" ${wizardState.selectedLeads.includes(l.id) ? 'checked' : ''}
              onchange="wizardToggleLead(${l.id}, this.checked)">
            <div class="wizard-lead-info">
              <strong>${l.name}</strong>
              <span class="text-muted">${l.email}</span>
            </div>
            <div class="text-sm text-muted">${l.company || ''}</div>
            <div>
              <span class="badge badge-${l.status}">${l.status}</span>
            </div>
            <div class="text-sm">
              <div class="score-bar" style="width:40px;display:inline-block;vertical-align:middle"><div class="score-fill" style="width:${l.score}%;background:${l.score > 70 ? 'var(--success)' : l.score > 40 ? 'var(--warning)' : 'var(--danger)'}"></div></div>
              ${l.score}
            </div>
          </label>
        `).join('')}
      </div>
    `;
  } catch (e) {
    const container = document.getElementById('wz-leads-container');
    if (container) container.innerHTML = `<div class="empty">Error loading leads: ${e.message}</div>`;
  }
}

function wizardToggleLead(id, checked) {
  if (checked && !wizardState.selectedLeads.includes(id)) {
    wizardState.selectedLeads.push(id);
  } else if (!checked) {
    wizardState.selectedLeads = wizardState.selectedLeads.filter(x => x !== id);
  }
  // Update visual
  const item = document.getElementById(`wz-lead-${id}`);
  if (item) item.classList.toggle('selected', checked);
  const countEl = document.getElementById('wz-lead-count');
  if (countEl) countEl.textContent = wizardState.selectedLeads.length;
}

function wizardSelectAllLeads() {
  wizardState.selectedLeads = wizardState.allLeads.map(l => l.id);
  loadWizardLeads();
}

function wizardDeselectAllLeads() {
  wizardState.selectedLeads = [];
  loadWizardLeads();
}

function renderWizardReview() {
  const d = wizardState.data;
  const leadCount = wizardState.selectedLeads.length;
  const selectedLeadNames = wizardState.allLeads
    .filter(l => wizardState.selectedLeads.includes(l.id))
    .map(l => l.name);

  return `
    <div class="wizard-review">
      <div class="wizard-review-section">
        <div class="wizard-review-label">Campaign Name</div>
        <div class="wizard-review-value">${d.name || '<span class="text-muted">Not set</span>'}</div>
      </div>
      <div class="wizard-review-section">
        <div class="wizard-review-label">Type</div>
        <div class="wizard-review-value"><span class="badge badge-active">${d.type}</span></div>
      </div>
      <div class="wizard-review-section">
        <div class="wizard-review-label">Target Audience</div>
        <div class="wizard-review-value">${d.target_audience || '<span class="text-muted">Not specified</span>'}</div>
      </div>
      ${d.type === 'email' ? `
        <div class="wizard-review-section">
          <div class="wizard-review-label">Subject</div>
          <div class="wizard-review-value">${d.subject || '<span class="text-muted">No subject</span>'}</div>
        </div>
      ` : ''}
      <div class="wizard-review-section">
        <div class="wizard-review-label">Content Preview</div>
        <div class="wizard-review-value">
          ${d.body ? `<div class="wizard-review-content">${d.body.substring(0, 300)}${d.body.length > 300 ? '...' : ''}</div>` : '<span class="text-muted">No content</span>'}
        </div>
      </div>
      <div class="wizard-review-section">
        <div class="wizard-review-label">Assigned Leads</div>
        <div class="wizard-review-value">
          ${leadCount > 0
            ? `<strong>${leadCount} lead${leadCount > 1 ? 's' : ''}</strong> — ${selectedLeadNames.slice(0, 5).join(', ')}${selectedLeadNames.length > 5 ? ` and ${selectedLeadNames.length - 5} more` : ''}`
            : '<span class="text-muted">No leads assigned — you can add them later</span>'}
        </div>
      </div>
      <div class="wizard-review-section">
        <div class="wizard-review-label">AI Budget Limit</div>
        <div class="wizard-review-value">
          ${d.budget_limit > 0 ? `<strong>$${d.budget_limit.toFixed(2)}</strong> — AI features will pause when this limit is reached` : '<span class="text-muted">No limit set — unlimited AI usage</span>'}
        </div>
      </div>
    </div>

    ${!d.name ? `
      <div class="wizard-warning">
        Please go back and enter a campaign name before saving.
      </div>
    ` : ''}
  `;
}

// Wizard Navigation
function wizardSaveCurrentStepData() {
  // Save form field values to state (for fields that use oninput, they're already saved)
  const nameEl = document.getElementById('wz-name');
  const audienceEl = document.getElementById('wz-audience');
  const subjectEl = document.getElementById('wz-subject');
  const bodyEl = document.getElementById('wz-body');

  const budgetEl = document.getElementById('wz-budget');

  if (nameEl) wizardState.data.name = nameEl.value;
  if (audienceEl) wizardState.data.target_audience = audienceEl.value;
  if (subjectEl) wizardState.data.subject = subjectEl.value;
  if (bodyEl) wizardState.data.body = bodyEl.value;
  if (budgetEl) wizardState.data.budget_limit = parseFloat(budgetEl.value) || 0;
}

function wizardNext() {
  wizardSaveCurrentStepData();

  // Validate current step
  if (wizardState.step === 0 && !wizardState.data.name.trim()) {
    showNotification('Please enter a campaign name to continue.', 'error');
    document.getElementById('wz-name')?.focus();
    return;
  }

  if (wizardState.step < WIZARD_STEPS.length - 1) {
    wizardState.step++;
    renderCampaignWizard();
  }
}

function wizardBack() {
  wizardSaveCurrentStepData();
  if (wizardState.step > 0) {
    wizardState.step--;
    renderCampaignWizard();
  }
}

function wizardGoTo(step) {
  wizardSaveCurrentStepData();
  wizardState.step = step;
  renderCampaignWizard();
}

function exitCampaignWizard() {
  if (wizardState && (wizardState.data.name || wizardState.data.body)) {
    if (!confirm('Are you sure? Your campaign progress will be lost.')) return;
  }
  wizardState = null;
  loadCampaigns();
}

async function wizardAiGenerate() {
  const btn = document.getElementById('wz-ai-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
  showNotification('AI is generating content...');

  try {
    const d = wizardState.data;
    let result;
    if (d.type === 'email') {
      result = await api.post('/agent/generate/email', {
        audience: d.target_audience, subject: d.subject, purpose: 'marketing', tone: 'professional'
      });
      wizardState.data.subject = result.subject || d.subject;
      wizardState.data.body = result.body_html || result.body_text || d.body;
    } else if (d.type === 'social') {
      result = await api.post('/agent/generate/social', {
        platform: 'linkedin', topic: d.name, tone: 'professional'
      });
      wizardState.data.body = typeof result === 'object' ? (result.post || result.content || JSON.stringify(result, null, 2)) : result;
    } else if (d.type === 'ad') {
      result = await api.post('/agent/generate/ad', {
        platform: 'google', objective: 'conversions', audience: d.target_audience, productInfo: d.name
      });
      wizardState.data.body = typeof result === 'object' ? (result.copy || result.headline || JSON.stringify(result, null, 2)) : result;
    } else {
      result = await api.post('/agent/generate/email', {
        audience: d.target_audience, subject: d.name, purpose: 'content marketing', tone: 'professional'
      });
      wizardState.data.body = result.body_text || result.body_html || d.body;
    }

    showNotification('Content generated!', 'success');
    renderCampaignWizard();
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Generate with AI'; }
  }
}

async function wizardSave(action) {
  wizardSaveCurrentStepData();
  const d = wizardState.data;

  if (!d.name.trim()) {
    showNotification('Please enter a campaign name.', 'error');
    wizardState.step = 0;
    renderCampaignWizard();
    return;
  }

  showNotification('Saving campaign...');

  try {
    let campaign;
    const payload = {
      name: d.name, type: d.type, subject: d.subject,
      body: d.body, target_audience: d.target_audience,
      budget_limit: d.budget_limit || 0,
    };

    if (wizardState.editId) {
      campaign = await api.put(`/campaigns/${wizardState.editId}`, payload);
    } else {
      campaign = await api.post('/campaigns', payload);
    }

    // Assign leads if any selected
    if (wizardState.selectedLeads.length > 0 && campaign.id) {
      await api.post(`/campaigns/${campaign.id}/leads`, { leadIds: wizardState.selectedLeads });
    }

    // Send if requested
    if (action === 'send' && campaign.id && d.type === 'email') {
      const sendResult = await api.post(`/campaigns/${campaign.id}/send`);
      showNotification(`Campaign saved & sent to ${sendResult.sent}/${sendResult.total} leads!`, 'success');
    } else {
      showNotification('Campaign saved as draft!', 'success');
    }

    wizardState = null;
    loadCampaigns();
  } catch (e) {
    showNotification('Error saving: ' + e.message, 'error');
  }
}

async function sendCampaign(id) {
  if (!confirm('Send this campaign to all assigned leads?')) return;
  showNotification('Sending campaign...');
  try {
    const result = await api.post(`/campaigns/${id}/send`);
    showNotification(`Sent to ${result.sent}/${result.total} leads`, 'success');
    loadCampaigns();
  } catch (e) { showNotification('Error: ' + e.message, 'error'); }
}

async function deleteCampaign(id) {
  if (!confirm('Delete this campaign?')) return;
  await api.del(`/campaigns/${id}`);
  loadCampaigns();
}

// ========== AI Content ==========
let contentWizard = null;

async function loadContent() {
  if (contentWizard) { renderContentWizard(); return; }

  try {
    const content = await api.get('/agent/content');
    document.getElementById('page').innerHTML = `
      <div class="toolbar">
        <h2>AI Generated Content</h2>
        <button class="btn btn-primary" onclick="startContentWizard()">+ Create Content</button>
      </div>
      ${content.length === 0 ? `
        <div class="card" style="text-align:center;padding:60px 20px">
          <div style="font-size:48px;margin-bottom:16px">&#9998;</div>
          <h3 style="color:var(--text);font-size:18px;margin-bottom:8px;text-transform:none;letter-spacing:0">Create Your First AI Content</h3>
          <p class="text-muted mb-4">Choose a content type and we'll guide you step by step. AI does the heavy lifting.</p>
          <button class="btn btn-primary" onclick="startContentWizard()" style="font-size:15px;padding:12px 24px">Get Started</button>
        </div>
      ` : content.map(c => {
        let parsed;
        try { parsed = JSON.parse(c.content); } catch { parsed = c.content; }
        return `<div class="content-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div class="type" style="margin-bottom:0">${c.type} — ${new Date(c.created_at).toLocaleString()}</div>
            <div class="flex gap-2">
              <button class="btn btn-sm btn-outline" onclick="editContent(${c.id})">Edit</button>
              <button class="btn btn-sm btn-primary" onclick="regenerateContent(${c.id}, '${c.type}')">Regenerate</button>
              <button class="btn btn-sm btn-danger" onclick="deleteContent(${c.id})">X</button>
            </div>
          </div>
          ${formatContentDisplay(c.type, parsed)}
        </div>`;
      }).join('')}
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

async function editContent(contentId) {
  try {
    const items = await api.get('/agent/content');
    const item = items.find(c => c.id === contentId);
    if (!item) { showNotification('Content not found', 'error'); return; }

    let parsed;
    try { parsed = JSON.parse(item.content); } catch { parsed = item.content; }

    // Build editable fields based on type
    let fields = '';
    if (typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) {
          fields += `<div class="form-group"><label>${key}</label><textarea id="ec-${key}" style="min-height:80px">${value.join('\n')}</textarea><small class="text-muted">One item per line</small></div>`;
        } else if (typeof value === 'string' && value.length > 100) {
          fields += `<div class="form-group"><label>${key}</label><textarea id="ec-${key}" style="min-height:120px">${value}</textarea></div>`;
        } else if (typeof value === 'string') {
          fields += `<div class="form-group"><label>${key}</label><input id="ec-${key}" value="${value.replace(/"/g, '&quot;')}"></div>`;
        }
      }
    } else {
      fields = `<div class="form-group"><label>Content</label><textarea id="ec-raw" style="min-height:200px">${parsed}</textarea></div>`;
    }

    modal = {
      title: `Edit ${item.type} Content`,
      body: `<div style="max-height:60vh;overflow-y:auto">${fields}</div>`,
      onSave: async () => {
        let updated;
        if (typeof parsed === 'object') {
          updated = {};
          for (const key of Object.keys(parsed)) {
            const el = document.getElementById(`ec-${key}`);
            if (!el) { updated[key] = parsed[key]; continue; }
            if (Array.isArray(parsed[key])) {
              updated[key] = el.value.split('\n').map(s => s.trim()).filter(Boolean);
            } else {
              updated[key] = el.value;
            }
          }
        } else {
          updated = document.getElementById('ec-raw')?.value || parsed;
        }
        await api.put(`/agent/content/${contentId}`, { content: updated });
        modal = null;
        showNotification('Content updated!', 'success');
        loadContent();
      },
    };
    render();
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
  }
}

async function regenerateContent(contentId, type) {
  if (!confirm('Regenerate this content with AI? The current content will be replaced.')) return;

  try {
    const items = await api.get('/agent/content');
    const item = items.find(c => c.id === contentId);
    if (!item) { showNotification('Content not found', 'error'); return; }

    let prompt;
    try { prompt = JSON.parse(item.prompt); } catch { prompt = {}; }

    showNotification('AI is regenerating content...');

    // Map stored type to API type
    const apiType = type === 'social_post' ? 'social' : type === 'ad_copy' ? 'ad' : type === 'seo_keywords' ? 'seo' : type;
    const result = await api.post(`/agent/generate/${apiType}`, prompt);

    // Update existing content with new result
    const { taskId, contentId: newId, _cost, ...newContent } = result;
    await api.put(`/agent/content/${contentId}`, { content: newContent });

    showNotification('Content regenerated!', 'success');
    loadContent();
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
  }
}

async function deleteContent(contentId) {
  if (!confirm('Delete this content?')) return;
  try {
    await api.del(`/agent/content/${contentId}`);
    showNotification('Content deleted', 'success');
    loadContent();
  } catch (e) {
    showNotification('Error: ' + e.message, 'error');
  }
}

// Format content nicely based on type instead of raw JSON
function formatContentDisplay(type, data) {
  if (typeof data === 'string') return `<div class="cw-rendered">${data}</div>`;

  switch (type) {
    case 'email': return `
      <div class="cw-rendered">
        <div class="cw-field"><span class="cw-label">Subject:</span> ${data.subject || ''}</div>
        <div class="cw-field"><span class="cw-label">Preview:</span> ${data.preview_text || ''}</div>
        <div class="cw-divider"></div>
        <div class="cw-body">${data.body_html || data.body_text || ''}</div>
      </div>`;

    case 'social_post': return `
      <div class="cw-rendered">
        <div class="cw-body" style="font-size:15px;line-height:1.6;white-space:pre-wrap">${data.post_text || ''}</div>
        ${data.hashtags?.length ? `<div class="cw-tags">${data.hashtags.map(h => `<span class="cw-tag">${h}</span>`).join(' ')}</div>` : ''}
        ${data.best_time_to_post ? `<div class="cw-field" style="margin-top:12px"><span class="cw-label">Best time to post:</span> ${data.best_time_to_post}</div>` : ''}
        ${data.engagement_tips?.length ? `
          <div class="cw-divider"></div>
          <div class="cw-label" style="margin-bottom:6px">Engagement Tips:</div>
          <ul class="cw-tips">${data.engagement_tips.map(t => `<li>${t}</li>`).join('')}</ul>
        ` : ''}
      </div>`;

    case 'ad_copy': return `
      <div class="cw-rendered">
        ${data.headline_options?.length ? `
          <div class="cw-label" style="margin-bottom:6px">Headlines:</div>
          <div class="cw-options">${data.headline_options.map((h,i) => `<div class="cw-option"><span class="cw-num">${i+1}</span> ${h}</div>`).join('')}</div>
        ` : ''}
        ${data.description_options?.length ? `
          <div class="cw-label" style="margin-top:12px;margin-bottom:6px">Descriptions:</div>
          <div class="cw-options">${data.description_options.map((d,i) => `<div class="cw-option"><span class="cw-num">${i+1}</span> ${d}</div>`).join('')}</div>
        ` : ''}
        ${data.cta_options?.length ? `
          <div class="cw-label" style="margin-top:12px;margin-bottom:6px">Call to Action:</div>
          <div class="cw-tags">${data.cta_options.map(c => `<span class="cw-tag">${c}</span>`).join(' ')}</div>
        ` : ''}
        ${data.targeting_suggestions ? `
          <div class="cw-divider"></div>
          <div class="cw-field"><span class="cw-label">Targeting:</span> ${data.targeting_suggestions}</div>
        ` : ''}
      </div>`;

    case 'seo_keywords': return `
      <div class="cw-rendered">
        ${data.primary_keywords?.length ? `
          <div class="cw-label" style="margin-bottom:6px">Primary Keywords:</div>
          <div class="cw-tags">${data.primary_keywords.map(k => `<span class="cw-tag">${k}</span>`).join(' ')}</div>
        ` : ''}
        ${data.long_tail_keywords?.length ? `
          <div class="cw-label" style="margin-top:12px;margin-bottom:6px">Long-Tail Keywords:</div>
          <div class="cw-tags">${data.long_tail_keywords.map(k => `<span class="cw-tag cw-tag-alt">${k}</span>`).join(' ')}</div>
        ` : ''}
        ${data.content_ideas?.length ? `
          <div class="cw-divider"></div>
          <div class="cw-label" style="margin-bottom:6px">Content Ideas:</div>
          ${data.content_ideas.map(idea => `
            <div class="cw-option" style="margin-bottom:6px">
              <strong>${idea.title || idea}</strong>
              ${idea.type ? `<span class="badge badge-active" style="margin-left:8px">${idea.type}</span>` : ''}
              ${idea.target_keyword ? `<div class="text-sm text-muted">Target: ${idea.target_keyword}</div>` : ''}
            </div>
          `).join('')}
        ` : ''}
        ${data.meta_description ? `
          <div class="cw-divider"></div>
          <div class="cw-field"><span class="cw-label">Meta Description:</span> ${data.meta_description}</div>
        ` : ''}
        ${data.optimization_tips?.length ? `
          <div class="cw-divider"></div>
          <div class="cw-label" style="margin-bottom:6px">Optimization Tips:</div>
          <ul class="cw-tips">${data.optimization_tips.map(t => `<li>${t}</li>`).join('')}</ul>
        ` : ''}
      </div>`;

    default: return `<pre style="white-space:pre-wrap">${JSON.stringify(data, null, 2)}</pre>`;
  }
}

// ===== Content Generation Wizard =====
const CONTENT_WIZARD_STEPS = [
  { id: 'type', label: 'Content Type', icon: '&#9998;' },
  { id: 'details', label: 'Details', icon: '&#9881;' },
  { id: 'generate', label: 'Generate & Review', icon: '&#9733;' },
  { id: 'share', label: 'Share', icon: '&#9992;' },
];

const POSTER_STYLES = [
  { id: 'none', label: 'No Poster', desc: 'Text content only', colors: null },
  { id: 'bold', label: 'Bold & Modern', desc: 'Dark bg, bright accent', colors: ['#1a1a2e', '#e94560', '#ffffff'] },
  { id: 'minimal', label: 'Clean Minimal', desc: 'White, light and airy', colors: ['#ffffff', '#2d3436', '#0984e3'] },
  { id: 'gradient', label: 'Gradient Glow', desc: 'Vibrant gradient', colors: ['#667eea', '#764ba2', '#ffffff'] },
  { id: 'nature', label: 'Warm & Natural', desc: 'Earthy tones', colors: ['#2d3436', '#e17055', '#ffeaa7'] },
  { id: 'tech', label: 'Tech & Digital', desc: 'Cyber blue, futuristic', colors: ['#0a0a2a', '#00d2ff', '#ffffff'] },
];

function startContentWizard(presetType) {
  contentWizard = {
    step: presetType ? 1 : 0,
    type: presetType || null,
    inputs: {},
    posterStyle: 'bold',
    result: null,
    generating: false,
  };
  renderContentWizard();
}

function renderContentWizard() {
  const page = document.getElementById('page');
  if (!page) return;

  const cw = contentWizard;
  const stepIdx = cw.step;
  const step = CONTENT_WIZARD_STEPS[stepIdx];

  page.innerHTML = `
    <div class="toolbar">
      <h2>Create AI Content</h2>
      <button class="btn btn-outline" onclick="exitContentWizard()">Cancel</button>
    </div>

    <!-- Progress -->
    <div class="wizard-progress">
      ${CONTENT_WIZARD_STEPS.map((ws, i) => `
        <div class="wizard-step ${i < stepIdx ? 'completed' : ''} ${i === stepIdx ? 'active' : ''}" onclick="${i < stepIdx ? `contentWizardGoTo(${i})` : ''}">
          <div class="wizard-step-circle">${i < stepIdx ? '&#10003;' : i + 1}</div>
          <div class="wizard-step-label">${ws.label}</div>
        </div>
        ${i < CONTENT_WIZARD_STEPS.length - 1 ? '<div class="wizard-step-line ' + (i < stepIdx ? 'completed' : '') + '"></div>' : ''}
      `).join('')}
    </div>

    <div class="card wizard-card">
      <div class="wizard-step-header">
        <span class="wizard-step-icon">${step.icon}</span>
        <div>
          <h3 style="color:var(--text);text-transform:none;letter-spacing:0;font-size:16px;margin-bottom:2px">Step ${stepIdx + 1}: ${step.label}</h3>
          <p class="text-muted text-sm">${getContentStepDesc(stepIdx)}</p>
        </div>
      </div>
      <div class="wizard-step-body">
        ${renderContentWizardStep(stepIdx)}
      </div>
    </div>

    <div class="wizard-nav">
      <div>
        ${stepIdx > 0 ? `<button class="btn btn-outline" onclick="contentWizardBack()">Back</button>` : ''}
      </div>
      <div class="flex gap-2">
        ${stepIdx === 0 && cw.type ? `
          <button class="btn btn-primary" onclick="contentWizardNext()">Next: Details &#8594;</button>
        ` : ''}
        ${stepIdx === 1 ? `
          <button class="btn btn-primary" onclick="contentWizardNext()">Next: Generate &#8594;</button>
        ` : ''}
        ${stepIdx === 2 && cw.result ? `
          <button class="btn btn-outline" onclick="contentWizardGenerate()">Regenerate</button>
          <button class="btn btn-primary" onclick="contentWizardNext()">Next: Share &#8594;</button>
        ` : ''}
        ${stepIdx === 3 ? `
          <button class="btn btn-primary" onclick="exitContentWizard(); loadContent();">Done</button>
        ` : ''}
      </div>
    </div>
  `;

  // Auto-generate on step 3 if no result yet
  if (stepIdx === 2 && !cw.result && !cw.generating) {
    contentWizardGenerate();
  }
}

function getContentStepDesc(step) {
  switch (step) {
    case 0: return 'What kind of content do you want to create?';
    case 1: return 'Tell us about your content so AI can tailor it perfectly.';
    case 2: return 'AI is creating your content. Review and tweak as needed.';
    case 3: return 'Share your content directly to social media platforms.';
  }
}

function renderContentWizardStep(step) {
  const cw = contentWizard;

  switch (step) {
    case 0: return `
      <div class="wizard-type-grid">
        ${[
          { val: 'email', icon: '&#9993;', title: 'Marketing Email', desc: 'Promotional emails, newsletters, follow-ups' },
          { val: 'social', icon: '&#128172;', title: 'Social Media Post', desc: 'LinkedIn, Twitter, Instagram, Facebook' },
          { val: 'ad', icon: '&#128226;', title: 'Ad Copy', desc: 'Google Ads, Facebook Ads, LinkedIn Ads' },
          { val: 'seo', icon: '&#128269;', title: 'SEO Strategy', desc: 'Keywords, content ideas, meta descriptions' },
        ].map(t => `
          <div class="wizard-type-card ${cw.type === t.val ? 'selected' : ''}"
            onclick="contentWizard.type='${t.val}'; contentWizard.inputs={}; renderContentWizard();">
            <div class="wizard-type-icon">${t.icon}</div>
            <div class="wizard-type-title">${t.title}</div>
            <div class="wizard-type-desc">${t.desc}</div>
          </div>
        `).join('')}
      </div>
    `;

    case 1:
      return renderContentDetailsForm(cw.type) + `
        ${cw.type !== 'seo' ? `
          <div class="cw-divider" style="margin:20px 0"></div>
          <div class="form-group">
            <label>Poster Design Style</label>
            <small class="text-muted" style="display:block;margin-bottom:8px">Choose a visual style for your content poster. Select "No Poster" for text only.</small>
            <div class="poster-style-grid">
              ${POSTER_STYLES.map(s => `
                <div class="poster-style-card ${cw.posterStyle === s.id ? 'selected' : ''}"
                  onclick="contentWizard.posterStyle='${s.id}'; renderContentWizard();">
                  ${s.colors ? `
                    <div class="poster-style-preview" style="background:${s.colors.length === 3 && s.id === 'gradient' ? `linear-gradient(135deg, ${s.colors[0]}, ${s.colors[1]})` : s.colors[0]}">
                      <div style="color:${s.colors[2] || '#fff'};font-size:10px;font-weight:700">Aa</div>
                      <div style="width:20px;height:3px;border-radius:2px;background:${s.colors[1]};margin-top:2px"></div>
                    </div>
                  ` : `<div class="poster-style-preview" style="background:var(--surface2);display:flex;align-items:center;justify-content:center"><span class="text-muted" style="font-size:10px">OFF</span></div>`}
                  <div class="poster-style-label">${s.label}</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      `;

    case 2:
      if (cw.generating) return `
        <div style="text-align:center;padding:40px">
          <div style="font-size:36px;margin-bottom:16px;animation:pulse 1.5s infinite">&#9733;</div>
          <h3 style="color:var(--text);text-transform:none;letter-spacing:0;margin-bottom:8px">AI is generating your content...</h3>
          <p class="text-muted">This usually takes a few seconds.</p>
        </div>
      `;
      if (cw.result) {
        const contentHtml = formatContentDisplay(
          cw.type === 'social' ? 'social_post' : cw.type === 'ad' ? 'ad_copy' : cw.type === 'seo' ? 'seo_keywords' : cw.type,
          cw.result
        );
        const posterHtml = cw.posterStyle !== 'none' && cw.type !== 'seo' ? renderPosterPreview(cw) : '';
        return posterHtml + contentHtml;
      }
      return '<div class="empty">Something went wrong. Click "Regenerate" to try again.</div>';

    case 3: return renderShareStep(cw);
  }
}

function renderContentDetailsForm(type) {
  const inp = contentWizard.inputs;
  switch (type) {
    case 'email': return `
      <div class="form-group">
        <label>What's the purpose of this email?</label>
        <select id="cw-purpose" onchange="contentWizard.inputs.purpose=this.value">
          ${['promotional','follow-up','nurture','announcement','welcome','re-engagement'].map(p => `<option value="${p}" ${inp.purpose===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}
        </select>
        <small class="text-muted">This helps AI match the right tone and structure.</small>
      </div>
      <div class="form-group">
        <label>Who is this email for?</label>
        <input id="cw-audience" value="${inp.audience||''}" placeholder="e.g., SaaS founders, new signups, existing customers..."
          oninput="contentWizard.inputs.audience=this.value">
        <small class="text-muted">Describe your target audience so the message resonates.</small>
      </div>
      <div class="form-group">
        <label>What tone should it have?</label>
        <select id="cw-tone" onchange="contentWizard.inputs.tone=this.value">
          ${['professional','casual','urgent','friendly','inspirational'].map(t => `<option value="${t}" ${inp.tone===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Describe your product or service</label>
        <textarea id="cw-product" placeholder="What are you promoting? Include key benefits, features, or offers..."
          oninput="contentWizard.inputs.productInfo=this.value" style="min-height:100px">${inp.productInfo||''}</textarea>
        <small class="text-muted">The more details you give, the better the email will be.</small>
      </div>
    `;

    case 'social': return `
      <div class="form-group">
        <label>Which platform?</label>
        <div class="wizard-type-grid" style="grid-template-columns:repeat(4,1fr)">
          ${['linkedin','twitter','instagram','facebook'].map(p => `
            <div class="wizard-type-card ${(inp.platform||'linkedin')===p?'selected':''}" style="padding:12px"
              onclick="contentWizard.inputs.platform='${p}'; renderContentWizard();">
              <div class="wizard-type-title" style="font-size:13px">${p.charAt(0).toUpperCase()+p.slice(1)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>What should the post be about?</label>
        <input id="cw-topic" value="${inp.topic||''}" placeholder="e.g., New product launch, industry insight, customer success story..."
          oninput="contentWizard.inputs.topic=this.value">
        <small class="text-muted">Describe the topic or key message you want to convey.</small>
      </div>
      <div class="form-group">
        <label>What tone?</label>
        <select id="cw-tone" onchange="contentWizard.inputs.tone=this.value">
          ${['professional','casual','inspirational','educational','humorous'].map(t => `<option value="${t}" ${inp.tone===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}
        </select>
      </div>
    `;

    case 'ad': return `
      <div class="form-group">
        <label>Which ad platform?</label>
        <div class="wizard-type-grid" style="grid-template-columns:repeat(4,1fr)">
          ${['google','facebook','linkedin','instagram'].map(p => `
            <div class="wizard-type-card ${(inp.platform||'google')===p?'selected':''}" style="padding:12px"
              onclick="contentWizard.inputs.platform='${p}'; renderContentWizard();">
              <div class="wizard-type-title" style="font-size:13px">${p.charAt(0).toUpperCase()+p.slice(1)}</div>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label>What's your campaign objective?</label>
        <select id="cw-objective" onchange="contentWizard.inputs.objective=this.value">
          ${['conversions','awareness','traffic','leads','app installs'].map(o => `<option value="${o}" ${inp.objective===o?'selected':''}>${o.charAt(0).toUpperCase()+o.slice(1)}</option>`).join('')}
        </select>
        <small class="text-muted">This shapes the ad copy style and call-to-action.</small>
      </div>
      <div class="form-group">
        <label>Who are you targeting?</label>
        <input id="cw-audience" value="${inp.audience||''}" placeholder="e.g., Small business owners, age 25-45, interested in marketing tools..."
          oninput="contentWizard.inputs.audience=this.value">
      </div>
      <div class="form-group">
        <label>Describe your product or service</label>
        <textarea id="cw-product" placeholder="What are you advertising? Include key selling points..."
          oninput="contentWizard.inputs.productInfo=this.value" style="min-height:100px">${inp.productInfo||''}</textarea>
      </div>
    `;

    case 'seo': return `
      <div class="form-group">
        <label>What topic or niche?</label>
        <input id="cw-topic" value="${inp.topic||''}" placeholder="e.g., AI marketing automation, organic skincare, cloud hosting..."
          oninput="contentWizard.inputs.topic=this.value">
        <small class="text-muted">The main topic you want to rank for.</small>
      </div>
      <div class="form-group">
        <label>What industry are you in?</label>
        <input id="cw-industry" value="${inp.industry||''}" placeholder="e.g., B2B SaaS, e-commerce, healthcare, food & beverage..."
          oninput="contentWizard.inputs.industry=this.value">
      </div>
      <div class="form-group">
        <label>Who are your competitors? (optional)</label>
        <input id="cw-competitors" value="${inp.competitors||''}" placeholder="e.g., HubSpot, Salesforce, Mailchimp..."
          oninput="contentWizard.inputs.competitors=this.value">
        <small class="text-muted">Helps AI suggest keywords your competitors may be missing.</small>
      </div>
    `;
  }
}

// Generate a beautiful poster as HTML
function renderPosterPreview(cw) {
  const style = POSTER_STYLES.find(s => s.id === cw.posterStyle);
  if (!style || !style.colors) return '';

  const data = cw.result || {};
  let headline = '';
  let subtitle = '';
  let cta = '';

  if (cw.type === 'email') {
    headline = data.subject || 'Your Email Subject';
    subtitle = data.preview_text || '';
    cta = 'Read More';
  } else if (cw.type === 'social') {
    const text = data.post_text || '';
    headline = text.split('\n')[0]?.substring(0, 80) || 'Social Post';
    subtitle = (data.hashtags || []).slice(0, 4).join(' ');
    cta = data.best_time_to_post ? `Post at ${data.best_time_to_post.substring(0, 20)}` : '';
  } else if (cw.type === 'ad') {
    headline = (data.headline_options || [])[0] || 'Your Ad Headline';
    subtitle = (data.description_options || [])[0] || '';
    cta = (data.cta_options || [])[0] || 'Learn More';
  }

  const bg = cw.posterStyle === 'gradient'
    ? `linear-gradient(135deg, ${style.colors[0]}, ${style.colors[1]})`
    : style.colors[0];
  const textColor = style.colors[2] || '#ffffff';
  const accentColor = style.colors[1];

  return `
    <div class="poster-container" id="poster-preview">
      <div class="poster" style="background:${bg};color:${textColor}">
        <div class="poster-badge" style="background:${accentColor};color:${cw.posterStyle === 'minimal' ? '#fff' : textColor}">
          ${cw.type === 'email' ? 'EMAIL' : cw.type === 'social' ? 'SOCIAL' : 'AD'}
        </div>
        <div class="poster-headline" style="color:${textColor}">${headline}</div>
        ${subtitle ? `<div class="poster-subtitle" style="color:${textColor};opacity:0.8">${subtitle}</div>` : ''}
        ${cta ? `<div class="poster-cta" style="background:${accentColor};color:${cw.posterStyle === 'minimal' ? '#fff' : textColor}">${cta}</div>` : ''}
        <div class="poster-brand" style="color:${textColor};opacity:0.5">SalesAgent AI</div>
      </div>
      <div class="text-sm text-muted" style="text-align:center;margin-top:8px">
        Poster Style: ${style.label}
        &nbsp;&middot;&nbsp;
        <a href="#" onclick="event.preventDefault(); downloadPoster()" style="color:var(--primary)">Download as Image</a>
      </div>
    </div>
    <div class="cw-divider" style="margin:16px 0"></div>
  `;
}

// Download poster as image using canvas
async function downloadPoster() {
  const poster = document.querySelector('.poster');
  if (!poster) return;

  try {
    // Use html2canvas-like approach with SVG foreignObject
    const html = poster.outerHTML;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml">${html}</div>
      </foreignObject>
    </svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'poster.svg';
    a.click();
    URL.revokeObjectURL(url);
    showNotification('Poster downloaded as SVG!', 'success');
  } catch (e) {
    showNotification('Error downloading: ' + e.message, 'error');
  }
}

// Share step - social media publishing
function renderShareStep(cw) {
  const data = cw.result || {};
  const postText = cw.type === 'social' ? (data.post_text || '') :
                   cw.type === 'email' ? (data.subject || '') :
                   cw.type === 'ad' ? ((data.headline_options || [])[0] || '') : '';
  const hashtags = (data.hashtags || []).join(' ');
  const shareText = encodeURIComponent(postText.substring(0, 280));

  const socials = [
    {
      id: 'linkedin', name: 'LinkedIn', icon: 'in',
      color: '#0077B5',
      shareUrl: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(window.location.origin)}&summary=${shareText}`,
      desc: 'Share as a LinkedIn post'
    },
    {
      id: 'twitter', name: 'Twitter / X', icon: 'X',
      color: '#1DA1F2',
      shareUrl: `https://twitter.com/intent/tweet?text=${shareText}`,
      desc: 'Tweet your content'
    },
    {
      id: 'facebook', name: 'Facebook', icon: 'f',
      color: '#1877F2',
      shareUrl: `https://www.facebook.com/sharer/sharer.php?quote=${shareText}`,
      desc: 'Share on Facebook'
    },
    {
      id: 'whatsapp', name: 'WhatsApp', icon: 'W',
      color: '#25D366',
      shareUrl: `https://wa.me/?text=${shareText}`,
      desc: 'Send via WhatsApp'
    },
    {
      id: 'telegram', name: 'Telegram', icon: 'T',
      color: '#0088cc',
      shareUrl: `https://t.me/share/url?text=${shareText}`,
      desc: 'Share on Telegram'
    },
    {
      id: 'clipboard', name: 'Copy Text', icon: '&#9986;',
      color: '#6c5ce7',
      shareUrl: null,
      desc: 'Copy content to clipboard'
    },
  ];

  return `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:32px;margin-bottom:8px">&#9992;</div>
      <h3 style="color:var(--text);text-transform:none;letter-spacing:0;margin-bottom:4px">Ready to Share!</h3>
      <p class="text-muted text-sm">Choose where to publish your content</p>
    </div>

    ${cw.posterStyle !== 'none' && cw.type !== 'seo' ? `
      <div style="margin-bottom:16px">
        ${renderPosterPreview(cw)}
      </div>
    ` : ''}

    <div class="share-preview">
      <div class="cw-label" style="margin-bottom:6px">Content Preview</div>
      <div class="share-preview-text">${postText.substring(0, 200)}${postText.length > 200 ? '...' : ''}</div>
      ${hashtags ? `<div class="cw-tags" style="margin-top:8px">${(data.hashtags || []).map(h => `<span class="cw-tag">${h}</span>`).join(' ')}</div>` : ''}
    </div>

    <div class="cw-divider" style="margin:16px 0"></div>

    <div class="share-grid">
      ${socials.map(s => `
        <button class="share-btn" style="--share-color:${s.color}"
          onclick="${s.shareUrl ? `window.open('${s.shareUrl}', '_blank', 'width=600,height=500')` : `copyContentToClipboard()`}">
          <div class="share-btn-icon" style="background:${s.color}">
            <span>${s.icon}</span>
          </div>
          <div class="share-btn-info">
            <div class="share-btn-name">${s.name}</div>
            <div class="share-btn-desc">${s.desc}</div>
          </div>
        </button>
      `).join('')}
    </div>
  `;
}

function copyContentToClipboard() {
  const cw = contentWizard;
  if (!cw?.result) return;

  const data = cw.result;
  let text = '';
  if (cw.type === 'social') text = data.post_text + '\n\n' + (data.hashtags || []).join(' ');
  else if (cw.type === 'email') text = 'Subject: ' + data.subject + '\n\n' + (data.body_text || data.body_html || '');
  else if (cw.type === 'ad') text = (data.headline_options || []).join('\n') + '\n\n' + (data.description_options || []).join('\n');
  else text = JSON.stringify(data, null, 2);

  navigator.clipboard.writeText(text).then(() => {
    showNotification('Content copied to clipboard!', 'success');
  }).catch(() => {
    showNotification('Failed to copy', 'error');
  });
}

function contentWizardSaveInputs() {
  const ids = {
    'cw-purpose': 'purpose', 'cw-audience': 'audience', 'cw-tone': 'tone',
    'cw-product': 'productInfo', 'cw-topic': 'topic', 'cw-platform': 'platform',
    'cw-objective': 'objective', 'cw-industry': 'industry', 'cw-competitors': 'competitors',
  };
  for (const [elId, key] of Object.entries(ids)) {
    const el = document.getElementById(elId);
    if (el) contentWizard.inputs[key] = el.value;
  }
}

function contentWizardNext() {
  contentWizardSaveInputs();
  if (contentWizard.step === 0 && !contentWizard.type) {
    showNotification('Please select a content type.', 'error');
    return;
  }
  contentWizard.step++;
  contentWizard.result = null;
  renderContentWizard();
}

function contentWizardBack() {
  contentWizardSaveInputs();
  contentWizard.step--;
  renderContentWizard();
}

function contentWizardGoTo(step) {
  contentWizardSaveInputs();
  contentWizard.step = step;
  renderContentWizard();
}

function exitContentWizard() {
  contentWizard = null;
  loadContent();
}

async function contentWizardGenerate() {
  const cw = contentWizard;
  cw.generating = true;
  cw.result = null;
  renderContentWizard();

  try {
    const inp = cw.inputs;
    let body = {};
    if (cw.type === 'email') body = { purpose: inp.purpose||'promotional', audience: inp.audience, tone: inp.tone||'professional', productInfo: inp.productInfo };
    if (cw.type === 'social') body = { platform: inp.platform||'linkedin', topic: inp.topic, tone: inp.tone||'professional' };
    if (cw.type === 'ad') body = { platform: inp.platform||'google', objective: inp.objective||'conversions', audience: inp.audience, productInfo: inp.productInfo };
    if (cw.type === 'seo') body = { topic: inp.topic, industry: inp.industry, competitors: inp.competitors };

    const result = await api.post(`/agent/generate/${cw.type}`, body);
    cw.result = result;
    cw.generating = false;
    showNotification('Content generated!', 'success');
    renderContentWizard();
  } catch (e) {
    cw.generating = false;
    showNotification('Error: ' + e.message, 'error');
    renderContentWizard();
  }
}

// Keep showGenerateModal for dashboard quick actions — redirect to wizard
function showGenerateModal(type) {
  navigate('content');
  setTimeout(() => startContentWizard(type), 100);
}

function gv(id) { return document.getElementById(id)?.value || ''; }

// ========== Chat ==========
let chatMessages = [];

function renderChatPage() {
  return `
    <div class="toolbar"><h2>AI Sales Assistant</h2></div>
    <div class="chat-container">
      <div class="chat-messages" id="chat-messages">
        ${chatMessages.length ? chatMessages.map(m => `
          <div class="chat-msg ${m.role}">${m.text}</div>
        `).join('') : `
          <div class="empty">
            <h3 style="margin-bottom:8px">Chat with your AI Sales Assistant</h3>
            <p class="text-muted">Ask about your leads, pipeline, campaigns, or get marketing advice.</p>
            <div class="flex gap-2" style="justify-content:center;margin-top:16px;flex-wrap:wrap">
              <button class="btn btn-outline" onclick="sendChat('What are my top priority leads right now?')">Top priority leads</button>
              <button class="btn btn-outline" onclick="sendChat('Suggest 5 marketing actions I should take this week')">Weekly actions</button>
              <button class="btn btn-outline" onclick="sendChat('How can I improve my email open rates?')">Improve open rates</button>
              <button class="btn btn-outline" onclick="sendChat('Write a follow-up strategy for cold leads')">Cold lead strategy</button>
            </div>
          </div>
        `}
      </div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Ask the AI assistant anything about sales & marketing..." onkeydown="if(event.key==='Enter')sendChat()">
        <button class="btn btn-primary" onclick="sendChat()">Send</button>
      </div>
    </div>
  `;
}

async function sendChat(text) {
  const input = document.getElementById('chat-input');
  const message = text || input?.value?.trim();
  if (!message) return;

  chatMessages.push({ role: 'user', text: message });
  if (input) input.value = '';
  renderChatMessages();

  try {
    const result = await api.post('/agent/chat', { message });
    chatMessages.push({ role: 'ai', text: result.response });
  } catch (e) {
    chatMessages.push({ role: 'ai', text: `Error: ${e.message}` });
  }
  renderChatMessages();
}

function renderChatMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;
  el.innerHTML = chatMessages.map(m => `<div class="chat-msg ${m.role}">${m.text}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

// ========== Bulk Import ==========
function showBulkImportModal() {
  modal = {
    title: 'Import Leads from CSV',
    body: `
      <div class="form-group">
        <label>Paste CSV data (name,email,company,title,phone,source)</label>
        <textarea id="f-csv" style="min-height:200px" placeholder="John Doe,john@example.com,Acme Inc,CEO,555-1234,linkedin
Jane Smith,jane@example.com,TechCorp,CTO,555-5678,website"></textarea>
      </div>
    `,
    onSave: async () => {
      const csv = document.getElementById('f-csv').value.trim();
      const lines = csv.split('\n').filter(l => l.trim());
      let imported = 0;
      for (const line of lines) {
        const [name, email, company, title, phone, source] = line.split(',').map(s => s.trim());
        if (name && email) {
          try {
            await api.post('/leads', { name, email, company, title, phone, source: source || 'import' });
            imported++;
          } catch (e) { /* skip duplicates */ }
        }
      }
      modal = null;
      showNotification(`Imported ${imported}/${lines.length} leads`, 'success');
      navigate('leads');
    },
  };
  render();
}

// ========== Modals & Notifications ==========
function renderModal() {
  return `
    <div class="modal-overlay" onclick="if(event.target===this){modal=null;render();}">
      <div class="modal">
        <h2>${modal.title}</h2>
        <div>${modal.body}</div>
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="modal=null;render();">Cancel</button>
          ${modal.onSave ? `<button class="btn btn-primary" onclick="modal.onSave()">${modal.saveLabel || 'Save'}</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function showResultModal(title, body) {
  modal = { title, body };
  render();
}

function showNotification(msg, type = 'info') {
  const n = document.createElement('div');
  n.style.cssText = `position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;z-index:200;font-size:14px;max-width:400px;animation:slideIn 0.3s;${
    type === 'error' ? 'background:var(--danger);' : type === 'success' ? 'background:var(--success);' : 'background:var(--primary);'
  }color:white;`;
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 4000);
}

// ========== Accounts (Superadmin) ==========
async function loadAccounts() {
  if (currentUser?.role !== 'superadmin') { navigate('dashboard'); return; }
  try {
    const users = await api.get('/users');
    const costData = await api.get('/campaigns/ai-costs').catch(() => ({ overall: { total_cost: 0 } }));
    const aiUsage = await api.get('/admin/ai-usage').catch(() => ({ total: { cost: 0, calls: 0, tokens: 0 }, thisMonth: { cost: 0, calls: 0 }, lastMonth: { cost: 0, calls: 0 }, daily: [], byModel: [], byType: [] }));
    const settingsData = await api.get('/settings').catch(() => ({}));
    const aiCreditBalance = parseFloat(settingsData.ai_credit_balance || '5.00');

    // Calculate revenue & profit
    const PLAN_PRICES = { starter: 99, pro: 199, business: 399 };
    const subscribers = users.filter(u => u.role !== 'superadmin');
    const activeSubscribers = subscribers.filter(u => u.status === 'active');
    const totalMRR = activeSubscribers.reduce((s, u) => s + (PLAN_PRICES[u.plan || 'starter'] || 0), 0);
    const totalAICost = costData.overall.total_cost || 0;
    const totalAICostMYR = totalAICost * 4.5; // USD to MYR approx
    const stripeFees = totalMRR * 0.029 + activeSubscribers.length * 1; // 2.9% + RM1 per txn
    const fixedCosts = 22.50 + 5; // Railway RM22.50 + Domain RM5
    const totalCosts = totalAICostMYR + stripeFees + fixedCosts;
    const netProfit = totalMRR - totalCosts;
    const planCounts = { starter: 0, pro: 0, business: 0 };
    activeSubscribers.forEach(u => { planCounts[u.plan || 'starter'] = (planCounts[u.plan || 'starter'] || 0) + 1; });

    document.getElementById('page').innerHTML = `
      <div class="toolbar">
        <h2>Account Management</h2>
        <button class="btn btn-primary" onclick="showCreateAccountModal()">+ Create Account</button>
      </div>

      <!-- Revenue Overview -->
      <div class="stats-grid" style="grid-template-columns:repeat(5,1fr)">
        <div class="stat-card" style="border-color:var(--primary)">
          <div class="stat-value" style="color:var(--primary)">RM ${totalMRR.toLocaleString()}</div>
          <div class="stat-label">Monthly Revenue (MRR)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value yellow">RM ${totalCosts.toFixed(0)}</div>
          <div class="stat-label">Total Costs</div>
        </div>
        <div class="stat-card" style="border-color:${netProfit >= 0 ? 'var(--success)' : 'var(--danger)'}">
          <div class="stat-value ${netProfit >= 0 ? 'green' : ''}" style="${netProfit < 0 ? 'color:var(--danger)' : ''}">RM ${netProfit.toFixed(0)}</div>
          <div class="stat-label">Net Profit/Month</div>
        </div>
        <div class="stat-card">
          <div class="stat-value blue">${activeSubscribers.length}</div>
          <div class="stat-label">Active Subscribers</div>
        </div>
        <div class="stat-card">
          <div class="stat-value purple">${subscribers.length > 0 ? Math.round((netProfit / totalMRR) * 100) || 0 : 0}%</div>
          <div class="stat-label">Profit Margin</div>
        </div>
      </div>

      <!-- Plan Breakdown -->
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat-card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div class="stat-value blue">${planCounts.starter}</div>
              <div class="stat-label">Starter (RM 99)</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:18px;font-weight:700;color:var(--primary)">RM ${planCounts.starter * 99}</div>
              <div class="text-muted text-sm">revenue</div>
            </div>
          </div>
        </div>
        <div class="stat-card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div class="stat-value green">${planCounts.pro}</div>
              <div class="stat-label">Pro (RM 199)</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:18px;font-weight:700;color:var(--primary)">RM ${planCounts.pro * 199}</div>
              <div class="text-muted text-sm">revenue</div>
            </div>
          </div>
        </div>
        <div class="stat-card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div class="stat-value purple">${planCounts.business}</div>
              <div class="stat-label">Business (RM 399)</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:18px;font-weight:700;color:var(--primary)">RM ${planCounts.business * 399}</div>
              <div class="text-muted text-sm">revenue</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Target Progress -->
      <div class="card">
        <h3>TARGET: RM 10,000/MONTH NET PROFIT</h3>
        <div style="margin:12px 0">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
            <span>RM ${Math.max(netProfit, 0).toFixed(0)} / RM 10,000</span>
            <span>${Math.min(Math.round((Math.max(netProfit, 0) / 10000) * 100), 100)}%</span>
          </div>
          <div style="height:12px;background:var(--surface2);border-radius:6px;overflow:hidden">
            <div style="height:100%;width:${Math.min((Math.max(netProfit, 0) / 10000) * 100, 100)}%;background:var(--teal-gradient);border-radius:6px;transition:width 0.3s"></div>
          </div>
          <div class="text-muted text-sm" style="margin-top:6px">
            ${netProfit >= 10000 ? 'TARGET ACHIEVED!' : `Need ${Math.ceil((10000 - netProfit) / 199)} more Pro subscribers or ${Math.ceil((10000 - netProfit) / 99)} Starter to reach target.`}
          </div>
        </div>
      </div>

      <!-- Operating Expenses -->
      <div class="card">
        <h3>OPERATING EXPENSES (MONTHLY)</h3>
        <table>
          <tr><th>Expense</th><th>Provider</th><th>Cost (MYR)</th><th>Cost (USD)</th><th>Status</th><th>Notes</th></tr>
          <tr>
            <td><strong>Cloud Hosting</strong></td>
            <td>Railway (Hobby)</td>
            <td>RM 22.50</td>
            <td>$5.00</td>
            <td><span class="badge badge-active">ACTIVE</span></td>
            <td>Docker container, auto-deploy, volume storage</td>
          </tr>
          <tr>
            <td><strong>AI API</strong></td>
            <td>Anthropic (Claude)</td>
            <td>RM ${(aiUsage.thisMonth.cost * 4.5).toFixed(2)}</td>
            <td>$${aiUsage.thisMonth.cost.toFixed(4)}</td>
            <td><span class="badge badge-${aiUsage.thisMonth.cost > 0 ? 'active' : 'draft'}">THIS MONTH</span></td>
            <td>${aiUsage.thisMonth.calls} calls this month. Pay-per-use.</td>
          </tr>
          <tr>
            <td><strong>Payment Processing</strong></td>
            <td>Stripe</td>
            <td>RM ${(totalMRR * 0.029 + activeSubscribers.length * 1).toFixed(2)}</td>
            <td>—</td>
            <td><span class="badge badge-active">ACTIVE</span></td>
            <td>2.9% + RM 1 per transaction. Scales with subscribers.</td>
          </tr>
          <tr>
            <td><strong>Domain</strong></td>
            <td>Registrar</td>
            <td>~RM 5</td>
            <td>—</td>
            <td><span class="badge badge-active">ACTIVE</span></td>
            <td>eiaawsolutions.com — annual cost / 12</td>
          </tr>
          <tr>
            <td><strong>DNS</strong></td>
            <td>Cloudflare</td>
            <td>RM 0</td>
            <td>$0</td>
            <td><span class="badge badge-active">FREE</span></td>
            <td>Free tier — DNS, SSL, CDN</td>
          </tr>
          <tr>
            <td><strong>Email (SMTP)</strong></td>
            <td>Gmail</td>
            <td>RM 0</td>
            <td>$0</td>
            <td><span class="badge badge-active">FREE</span></td>
            <td>Free tier — 500 emails/day</td>
          </tr>
          <tr style="font-weight:700;border-top:2px solid var(--border)">
            <td>TOTAL MONTHLY</td>
            <td></td>
            <td style="color:var(--warning)">RM ${(22.50 + (aiUsage.thisMonth.cost * 4.5) + (totalMRR * 0.029 + activeSubscribers.length) + 5).toFixed(2)}</td>
            <td></td>
            <td></td>
            <td>Excludes one-time costs</td>
          </tr>
        </table>
      </div>

      <!-- AI API Tracker -->
      <div class="card">
        <h3>AI API USAGE TRACKER</h3>
        <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
          <div class="stat-card">
            <div class="stat-value yellow">$${aiUsage.total.cost.toFixed(4)}</div>
            <div class="stat-label">Total AI Spend (all time)</div>
          </div>
          <div class="stat-card">
            <div class="stat-value blue">$${aiUsage.thisMonth.cost.toFixed(4)}</div>
            <div class="stat-label">This Month</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color:var(--text-muted)">$${aiUsage.lastMonth.cost.toFixed(4)}</div>
            <div class="stat-label">Last Month</div>
          </div>
          <div class="stat-card">
            <div class="stat-value green">${(aiUsage.total.tokens / 1000).toFixed(0)}k</div>
            <div class="stat-label">Total Tokens</div>
          </div>
        </div>

        <!-- Credit Balance & Top-up Warning -->
        ${(() => {
          const remaining = Math.max(aiCreditBalance - aiUsage.total.cost, 0);
          const pct = aiCreditBalance > 0 ? (remaining / aiCreditBalance) * 100 : 0;
          const dailyRate = aiUsage.thisMonth.cost / Math.max(new Date().getDate(), 1);
          const daysLeft = dailyRate > 0 ? Math.round(remaining / dailyRate) : 999;
          const isLow = remaining < 1 || pct < 20;
          const isWarning = remaining < 2 || pct < 40;
          return `
        <div style="background:${isLow ? 'rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3)' : isWarning ? 'rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3)' : 'rgba(46,196,182,0.1);border:1px solid rgba(46,196,182,0.2)'};border-radius:8px;padding:16px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <strong style="font-size:16px;color:${isLow ? 'var(--danger)' : isWarning ? 'var(--warning)' : 'var(--primary)'}">
                ${isLow ? 'LOW BALANCE — Top up now!' : isWarning ? 'Monitor — balance decreasing' : 'Healthy — credits available'}
              </strong>
              <div class="text-sm text-muted" style="margin-top:4px">
                ~${daysLeft} days remaining at current rate (~$${dailyRate.toFixed(3)}/day).
                <a href="https://console.anthropic.com/settings/billing" target="_blank" style="color:var(--primary);margin-left:8px">Top up credits &rarr;</a>
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:22px;font-weight:800;color:${isLow ? 'var(--danger)' : isWarning ? 'var(--warning)' : 'var(--primary)'}">$${remaining.toFixed(2)}</div>
              <div class="text-muted text-sm">remaining</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
            <div style="background:var(--bg);border-radius:6px;padding:8px">
              <div style="font-size:14px;font-weight:700;color:var(--primary)">$${aiCreditBalance.toFixed(2)}</div>
              <div style="font-size:10px;color:var(--text-muted)">LOADED</div>
            </div>
            <div style="background:var(--bg);border-radius:6px;padding:8px">
              <div style="font-size:14px;font-weight:700;color:var(--warning)">$${aiUsage.total.cost.toFixed(4)}</div>
              <div style="font-size:10px;color:var(--text-muted)">USED</div>
            </div>
            <div style="background:var(--bg);border-radius:6px;padding:8px">
              <div style="font-size:14px;font-weight:700;color:${isLow ? 'var(--danger)' : 'var(--success)'}">$${remaining.toFixed(2)}</div>
              <div style="font-size:10px;color:var(--text-muted)">REMAINING</div>
            </div>
            <div style="background:var(--bg);border-radius:6px;padding:8px">
              <div style="font-size:14px;font-weight:700">${aiUsage.total.calls}</div>
              <div style="font-size:10px;color:var(--text-muted)">TOTAL CALLS</div>
            </div>
          </div>
          <div style="margin-top:10px">
            <div style="height:8px;background:var(--surface2);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${100 - pct}%;background:${isLow ? 'var(--danger)' : isWarning ? 'var(--warning)' : 'var(--primary)'};border-radius:4px;transition:width 0.3s"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:4px">
              <span>$0</span>
              <span>${Math.round(100 - pct)}% used</span>
              <span>$${aiCreditBalance.toFixed(2)}</span>
            </div>
          </div>
        </div>`;
        })()}

        <!-- Usage by Model -->
        ${aiUsage.byModel.length > 0 ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <div class="cw-label" style="margin-bottom:8px">By Model</div>
              ${aiUsage.byModel.map(m => `
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(42,84,112,0.3);font-size:13px">
                  <span>${m.model?.split('-').slice(0,2).join(' ') || 'Unknown'}</span>
                  <span>${m.calls} calls — <strong>$${m.cost.toFixed(4)}</strong></span>
                </div>
              `).join('')}
            </div>
            <div>
              <div class="cw-label" style="margin-bottom:8px">By Action Type</div>
              ${aiUsage.byType.map(t => `
                <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(42,84,112,0.3);font-size:13px">
                  <span>${t.task_type?.replace(/_/g, ' ') || 'Unknown'}</span>
                  <span>${t.calls}x — <strong>$${t.cost.toFixed(4)}</strong></span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : '<div class="text-muted text-sm">No AI usage yet.</div>'}

        <!-- Last 7 Days Chart -->
        ${aiUsage.daily.length > 0 ? `
          <div style="margin-top:16px">
            <div class="cw-label" style="margin-bottom:8px">Last 7 Days</div>
            <div style="display:flex;align-items:end;gap:4px;height:60px">
              ${aiUsage.daily.map(d => {
                const maxCost = Math.max(...aiUsage.daily.map(x => x.cost), 0.001);
                const h = Math.max((d.cost / maxCost) * 100, 5);
                return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
                  <div style="font-size:9px;color:var(--text-muted)">$${d.cost.toFixed(3)}</div>
                  <div style="width:100%;height:${h}%;background:var(--teal-gradient);border-radius:3px;min-height:3px" title="${d.day}: $${d.cost.toFixed(4)} (${d.calls} calls)"></div>
                  <div style="font-size:9px;color:var(--text-muted)">${d.day.slice(5)}</div>
                </div>`;
              }).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <!-- Subscriber Cards -->
      ${subscribers.length > 0 ? `
        <div class="card">
          <h3>SUBSCRIBER EARNINGS & COSTS</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:12px">
            ${subscribers.map(u => {
              const planPrice = PLAN_PRICES[u.plan || 'starter'] || 99;
              const aiCostMYR = (u.ai_spend || 0) * 4.5;
              const profit = planPrice - aiCostMYR;
              const profitPct = planPrice > 0 ? Math.round((profit / planPrice) * 100) : 0;
              return `
              <div style="background:var(--bg);border:1px solid ${u.status === 'active' ? 'var(--border)' : 'var(--danger)'};border-radius:10px;padding:16px">
                <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
                  <div>
                    <strong style="font-size:14px">${esc(u.display_name || u.username)}</strong>
                    <div class="text-muted text-sm">${esc(u.email)}</div>
                  </div>
                  <div style="text-align:right">
                    <span class="badge badge-${(u.plan||'starter') === 'business' ? 'active' : (u.plan||'starter') === 'pro' ? 'qualified' : 'new'}">${(u.plan||'starter').toUpperCase()}</span>
                    <div class="text-sm" style="margin-top:2px"><span class="badge badge-${u.status === 'active' ? 'active' : 'paused'}">${u.status}</span></div>
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;margin-bottom:10px">
                  <div style="background:var(--surface);border-radius:6px;padding:8px">
                    <div style="font-size:16px;font-weight:700;color:var(--primary)">RM ${planPrice}</div>
                    <div class="text-muted" style="font-size:10px">EARNS/mo</div>
                  </div>
                  <div style="background:var(--surface);border-radius:6px;padding:8px">
                    <div style="font-size:16px;font-weight:700;color:var(--warning)">RM ${aiCostMYR.toFixed(1)}</div>
                    <div class="text-muted" style="font-size:10px">AI COST</div>
                  </div>
                  <div style="background:var(--surface);border-radius:6px;padding:8px">
                    <div style="font-size:16px;font-weight:700;color:${profit >= 0 ? 'var(--success)' : 'var(--danger)'}">RM ${profit.toFixed(0)}</div>
                    <div class="text-muted" style="font-size:10px">PROFIT (${profitPct}%)</div>
                  </div>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)">
                  <span>${u.lead_count} leads &middot; ${u.campaign_count} campaigns</span>
                  <span>${u.ai_spend > 0 ? (u.total_tokens/1000).toFixed(0) + 'k tokens' : 'No AI usage'}</span>
                </div>
                <div style="display:flex;gap:6px;margin-top:10px">
                  <button class="btn btn-sm btn-outline" style="flex:1" onclick="showEditAccountModal(${u.id})">Edit</button>
                  <button class="btn btn-sm" style="flex:1;background:${u.status === 'active' ? 'var(--warning)' : 'var(--success)'};color:white"
                    onclick="toggleAccountStatus(${u.id}, '${u.status === 'active' ? 'suspended' : 'active'}')">
                    ${u.status === 'active' ? 'Suspend' : 'Activate'}
                  </button>
                  <button class="btn btn-sm btn-danger" onclick="deleteAccount(${u.id}, '${u.username}')">X</button>
                </div>
              </div>
            `; }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- All Users Table -->
      <div class="card">
        <h3>ALL ACCOUNTS</h3>
        <table>
          <tr><th>User</th><th>Plan</th><th>Status</th><th>Earns</th><th>AI Cost</th><th>Profit</th><th>Leads</th><th>Campaigns</th><th>Actions</th></tr>
          ${users.map(u => {
            const planPrice = u.role === 'superadmin' ? 0 : (PLAN_PRICES[u.plan || 'starter'] || 0);
            const aiCostMYR = (u.ai_spend || 0) * 4.5;
            const profit = planPrice - aiCostMYR;
            return `
            <tr>
              <td>
                <strong>${esc(u.display_name || u.username)}</strong>
                <div class="text-muted text-sm">${esc(u.email)}</div>
              </td>
              <td><span class="badge badge-${(u.plan||'starter') === 'business' ? 'active' : (u.plan||'starter') === 'pro' ? 'qualified' : 'new'}">${(u.plan||'starter').toUpperCase()}</span>${u.role === 'superadmin' ? ' <span class="badge badge-active">ADMIN</span>' : ''}</td>
              <td><span class="badge badge-${u.status === 'active' ? 'active' : 'paused'}">${u.status}</span></td>
              <td style="color:var(--primary);font-weight:600">RM ${planPrice}</td>
              <td style="color:var(--warning)">RM ${aiCostMYR.toFixed(1)}</td>
              <td style="color:${profit >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600">RM ${profit.toFixed(0)}</td>
              <td>${u.lead_count}</td>
              <td>${u.campaign_count}</td>
              <td>
                <button class="btn btn-sm btn-outline" onclick="showEditAccountModal(${u.id})">Edit</button>
              </td>
            </tr>
          `; }).join('')}
        </table>
      </div>
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function showCreateAccountModal() {
  modal = {
    title: 'Create New Account',
    body: `
      <div class="form-group"><label>Username *</label><input id="f-username" placeholder="e.g. john"></div>
      <div class="form-group"><label>Email *</label><input id="f-email" type="email" placeholder="john@company.com"></div>
      <div class="form-group"><label>Display Name</label><input id="f-display" placeholder="John Smith"></div>
      <div class="form-group"><label>Password *</label><input id="f-password" type="password" placeholder="Min 8 characters"></div>
      <div class="grid-2">
        <div class="form-group"><label>Role</label>
          <select id="f-role"><option value="user">User</option><option value="superadmin">Super Admin</option></select>
        </div>
        <div class="form-group"><label>Subscription Plan</label>
          <select id="f-plan">
            <option value="starter">Starter (RM 99/mo)</option>
            <option value="pro" selected>Pro (RM 199/mo)</option>
            <option value="business">Business (RM 399/mo)</option>
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group"><label>AI Budget Limit ($)</label><input id="f-budget" type="number" step="0.01" value="0" placeholder="0 = unlimited"></div>
        <div class="form-group"><label>Monthly System Cost (RM)</label><input id="f-monthly" type="number" step="0.01" value="99" placeholder="Subscription fee"></div>
      </div>
    `,
    onSave: async () => {
      const data = {
        username: gv('f-username'), email: gv('f-email'), display_name: gv('f-display'),
        password: document.getElementById('f-password')?.value,
        role: gv('f-role'), plan: gv('f-plan'),
        budget_limit: parseFloat(gv('f-budget')) || 0,
        monthly_system_cost: parseFloat(gv('f-monthly')) || 0,
      };
      await api.post('/users', data);
      modal = null;
      showNotification('Account created!', 'success');
      navigate('accounts');
    },
  };
  render();
}

async function showEditAccountModal(userId) {
  const user = await api.get(`/users/${userId}`);
  modal = {
    title: `Edit Account: ${user.display_name || user.username}`,
    body: `
      <div class="form-group"><label>Display Name</label><input id="f-display" value="${user.display_name || ''}"></div>
      <div class="form-group"><label>Email</label><input id="f-email" value="${user.email}"></div>
      <div class="grid-2">
        <div class="form-group"><label>Role</label>
          <select id="f-role">${['user','superadmin'].map(r => `<option value="${r}" ${user.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label>Subscription Plan</label>
          <select id="f-plan">${['starter','pro','business'].map(p => `<option value="${p}" ${(user.plan||'starter') === p ? 'selected' : ''}>${p.charAt(0).toUpperCase()+p.slice(1)}${p==='starter'?' (RM 99)':p==='pro'?' (RM 199)':' (RM 399)'}</option>`).join('')}</select>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label>AI Budget Limit ($)</label>
          <input id="f-budget" type="number" step="0.01" value="${user.budget_limit || 0}">
          <small class="text-muted">Current AI spend: $${(user.ai_spend || 0).toFixed(4)}</small>
        </div>
        <div class="form-group">
          <label>Monthly System Cost (RM)</label>
          <input id="f-monthly" type="number" step="0.01" value="${user.monthly_system_cost || 0}">
          <small class="text-muted">Subscription fee charged to user</small>
        </div>
      </div>
      <div class="form-group">
        <label>New Password (leave empty to keep current)</label>
        <input id="f-password" type="password" placeholder="Leave blank to keep">
      </div>
    `,
    onSave: async () => {
      await api.put(`/users/${userId}`, {
        display_name: gv('f-display'), email: gv('f-email'), role: gv('f-role'),
        plan: gv('f-plan'),
        budget_limit: parseFloat(gv('f-budget')) || 0,
        monthly_system_cost: parseFloat(gv('f-monthly')) || 0,
      });
      const newPass = document.getElementById('f-password')?.value;
      if (newPass) await api.put(`/users/${userId}/password`, { password: newPass });
      modal = null;
      showNotification('Account updated!', 'success');
      navigate('accounts');
    },
  };
  render();
}

async function toggleAccountStatus(userId, newStatus) {
  if (!confirm(`${newStatus === 'suspended' ? 'Suspend' : 'Activate'} this account?`)) return;
  await api.put(`/users/${userId}`, { status: newStatus });
  showNotification(`Account ${newStatus}`, 'success');
  loadAccounts();
}

async function deleteAccount(userId, username) {
  if (!confirm(`Delete account "${username}" and ALL their data? This cannot be undone.`)) return;
  await api.del(`/users/${userId}`);
  showNotification('Account deleted', 'success');
  loadAccounts();
}

// ========== System Overview (Superadmin) ==========
function loadSystemOverview() {
  if (currentUser?.role !== 'superadmin') { navigate('dashboard'); return; }

  document.getElementById('page').innerHTML = `
    <div class="toolbar"><h2>System Overview</h2></div>

    <!-- Pricing & Plans -->
    <div class="card">
      <h3>SUBSCRIPTION PLANS — WHAT CLIENTS GET</h3>
      <table>
        <tr><th>Feature</th><th style="text-align:center;color:var(--text-muted)">Starter<br><small>RM 99/mo</small></th><th style="text-align:center;color:var(--primary)">Pro<br><small>RM 199/mo</small></th><th style="text-align:center;color:var(--success)">Business<br><small>RM 399/mo</small></th></tr>
        <tr><td>Leads</td><td style="text-align:center">100</td><td style="text-align:center">500</td><td style="text-align:center">Unlimited</td></tr>
        <tr><td>Campaigns</td><td style="text-align:center">3</td><td style="text-align:center">10</td><td style="text-align:center">Unlimited</td></tr>
        <tr><td>AI Actions/month</td><td style="text-align:center">50</td><td style="text-align:center">200</td><td style="text-align:center">1,000</td></tr>
        <tr><td>AI Model</td><td style="text-align:center">Haiku (fast)</td><td style="text-align:center">Sonnet</td><td style="text-align:center">Sonnet (priority)</td></tr>
        <tr><td>Team Users</td><td style="text-align:center">1</td><td style="text-align:center">3</td><td style="text-align:center">10</td></tr>
        <tr><td>Lead Management</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>Campaign Wizard</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI Email Generation (AIDA)</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI Social Post Generation</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>Sales Pipeline Kanban</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI Lead Scoring</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI Chat Assistant</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>Poster Design</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>Social Sharing</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td><strong>Auto-Outreach (AI sequences)</strong></td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td><strong>AI Lead Generation</strong></td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI Ad Copy + A/B Test Plans</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI SEO Strategy</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>Pipeline AI Analysis</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>14-Day Free Trial</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
      </table>
    </div>

    <!-- Revenue Target -->
    <div class="card">
      <h3>REVENUE TARGET — RM 10,000/MONTH NET PROFIT</h3>
      <table>
        <tr><th>Scenario</th><th>Users</th><th>MRR</th><th>AI Cost</th><th>Infra</th><th>Net Profit</th></tr>
        <tr><td>All Starter</td><td>115</td><td>RM 11,385</td><td>RM 1,380</td><td>RM 300</td><td style="color:var(--success)"><strong>RM 9,705</strong></td></tr>
        <tr style="background:rgba(46,196,182,0.05)"><td><strong>Mixed (recommended)</strong></td><td><strong>65</strong></td><td><strong>RM 11,935</strong></td><td><strong>RM 1,185</strong></td><td><strong>RM 300</strong></td><td style="color:var(--success)"><strong>RM 10,450</strong></td></tr>
        <tr><td>All Pro</td><td>58</td><td>RM 11,542</td><td>RM 1,044</td><td>RM 300</td><td style="color:var(--success)"><strong>RM 10,198</strong></td></tr>
      </table>
      <div style="margin-top:12px;font-size:13px;color:var(--text-muted)">
        Mixed = 30 Starter + 25 Pro + 10 Business. AI cost ~RM 9-18/user/mo (Sonnet avg). Infra = Railway + domain.
      </div>
    </div>

    <!-- Revenue Ramp -->
    <div class="card">
      <h3>REVENUE RAMP PROJECTION</h3>
      <table>
        <tr><th>Month</th><th>Users</th><th>MRR</th><th>Costs</th><th>Net Profit</th></tr>
        <tr><td>Month 1</td><td>5</td><td>RM 750</td><td>RM 350</td><td>RM 400</td></tr>
        <tr><td>Month 2</td><td>15</td><td>RM 2,250</td><td>RM 550</td><td>RM 1,700</td></tr>
        <tr><td>Month 3</td><td>30</td><td>RM 4,500</td><td>RM 800</td><td>RM 3,700</td></tr>
        <tr><td>Month 4</td><td>45</td><td>RM 7,000</td><td>RM 1,050</td><td>RM 5,950</td></tr>
        <tr><td>Month 5</td><td>55</td><td>RM 8,500</td><td>RM 1,200</td><td>RM 7,300</td></tr>
        <tr><td>Month 6</td><td>65</td><td>RM 10,500</td><td>RM 1,350</td><td style="color:var(--success)"><strong>RM 9,150</strong></td></tr>
        <tr style="background:rgba(46,196,182,0.05)"><td><strong>Month 7</strong></td><td><strong>75</strong></td><td><strong>RM 12,000</strong></td><td><strong>RM 1,500</strong></td><td style="color:var(--success)"><strong>RM 10,500 &#10003;</strong></td></tr>
      </table>
    </div>

    <!-- Super Sales Agent Skills -->
    <div class="card">
      <h3>SUPER SALES AGENT — AI CAPABILITIES</h3>
      <p class="text-muted text-sm mb-4">Every AI interaction uses these elite sales skills. This is what makes your product better than competitors.</p>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">
        ${[
          { icon: '&#127919;', title: 'Sales Strategy & Closing', desc: 'SPIN Selling, Challenger Sale, MEDDIC, Sandler frameworks. Handles top 20 objections (price, timing, competition, authority, need). Creates urgency without being pushy.' },
          { icon: '&#9733;', title: 'Lead Qualification & Scoring', desc: 'BANT framework with temperature tracking (cold → warm → hot → ready to buy). Scores 0-100 with clear reasoning the salesperson can read and act on.' },
          { icon: '&#9993;', title: 'Outreach & Follow-up', desc: 'Day 0/3/7/14 cadence. Channel mix (email, LinkedIn, WhatsApp). Subject lines designed for 40%+ open rates. Every message has exactly ONE call-to-action.' },
          { icon: '&#9998;', title: 'Content & Copywriting', desc: 'AIDA framework emails (Attention → Interest → Desire → Action). P.S. lines (most-read part of emails). Benefit-led, not feature-led. Ready to copy-paste.' },
          { icon: '&#128269;', title: 'SEO & Digital Marketing', desc: 'Commercial intent keywords that drive SALES. Competitor gap analysis. Quick wins for THIS WEEK. Malaysian local SEO. Meta descriptions as ad copy for organic search.' },
          { icon: '&#127912;', title: 'Social Media & Design', desc: 'Platform-specific: LinkedIn (long-form), Instagram (visual), Twitter (punchy), Facebook (community). Design suggestions with color psychology. Best times for MYT.' },
          { icon: '&#128222;', title: 'Cold Call to Buyer Conversion', desc: 'Opening scripts with personal observations. Pain-discovery questions. Bridge-to-solution framework. Handles "send me an email" objection. Converts cold to warm.' },
          { icon: '&#128200;', title: 'Pipeline Management', desc: 'Identifies stuck deals and at-risk opportunities. Activity-based scoring. Revenue forecasting (optimistic/realistic/pessimistic). Win/loss pattern analysis.' },
        ].map(s => `
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px">
            <div style="font-size:20px;margin-bottom:6px">${s.icon}</div>
            <div style="font-weight:700;font-size:14px;margin-bottom:4px">${s.title}</div>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.6">${s.desc}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Competitive Advantage -->
    <div class="card">
      <h3>COMPETITIVE ADVANTAGE VS MARKET</h3>
      <table>
        <tr><th>Feature</th><th style="text-align:center;color:var(--primary)">EIAAW SalesAgent</th><th style="text-align:center">HubSpot</th><th style="text-align:center">Apollo.io</th><th style="text-align:center">Instantly.ai</th></tr>
        <tr><td>AI Lead Generation</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003; Built-in</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center">DB only</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr><td>AI Content (email+social+ads+SEO)</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003; All 4</td><td style="text-align:center">Paid add-on</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr><td>AI Lead Scoring + Reasoning</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003;</td><td style="text-align:center">Enterprise</td><td style="text-align:center">Basic</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr><td>Auto-Outreach (AI-personalized)</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003;</td><td style="text-align:center">Add-on</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td></tr>
        <tr><td>AI Chat (full CRM context)</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003;</td><td style="text-align:center">Beta</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr><td>Pipeline + AI Analysis</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003;</td><td style="text-align:center;color:var(--success)">&#10003;</td><td style="text-align:center">Basic</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr><td>Poster Design for Social</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr><td>Cold Call Script Generator</td><td style="text-align:center;color:var(--primary);font-weight:700">&#10003;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td><td style="text-align:center;color:var(--text-muted)">&#10007;</td></tr>
        <tr style="font-weight:700"><td>Starting Price</td><td style="text-align:center;color:var(--primary)">RM 99/mo</td><td style="text-align:center">Free-RM 3,600</td><td style="text-align:center">Free-$99</td><td style="text-align:center">$30-$77</td></tr>
      </table>
    </div>

    <!-- Unit Economics -->
    <div class="card">
      <h3>UNIT ECONOMICS — COST PER USER</h3>
      <table>
        <tr><th>Cost Item</th><th>Per User/Month</th><th>Notes</th></tr>
        <tr><td>AI API (Sonnet avg)</td><td>RM 9-18 ($2-4)</td><td>50-200 AI actions</td></tr>
        <tr><td>Server (shared)</td><td>~RM 2</td><td>Railway $5/mo shared</td></tr>
        <tr><td>SMTP (email)</td><td>~RM 0.45</td><td>Gmail/SendGrid</td></tr>
        <tr style="font-weight:700"><td>Total Cost/User</td><td>RM 12-21</td><td></td></tr>
        <tr style="font-weight:700;color:var(--success)"><td>Gross Margin</td><td>80-85%</td><td>At RM 99-399 pricing</td></tr>
      </table>
    </div>

    <!-- AI Cost Per Action -->
    <div class="card">
      <h3>AI COST PER ACTION (SONNET)</h3>
      <table>
        <tr><th>Action</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost (USD)</th></tr>
        <tr><td>Lead Scoring</td><td>~600</td><td>~150</td><td>$0.011</td></tr>
        <tr><td>Lead Qualification (BANT)</td><td>~400</td><td>~200</td><td>$0.009</td></tr>
        <tr><td>Email Generation (AIDA)</td><td>~500</td><td>~400</td><td>$0.012</td></tr>
        <tr><td>Social Post + Design Tips</td><td>~400</td><td>~300</td><td>$0.008</td></tr>
        <tr><td>Ad Copy + A/B Plan</td><td>~400</td><td>~500</td><td>$0.013</td></tr>
        <tr><td>SEO Strategy</td><td>~350</td><td>~400</td><td>$0.010</td></tr>
        <tr><td>Pipeline Analysis</td><td>~2000</td><td>~300</td><td>$0.012</td></tr>
        <tr><td>Auto-Outreach (per 3 leads)</td><td>~800</td><td>~600</td><td>$0.015</td></tr>
        <tr><td>AI Chat (full CRM context)</td><td>~3000-8000</td><td>~500</td><td>$0.03-0.13</td></tr>
        <tr><td>Auto-Generate 5 Leads</td><td>~400</td><td>~1000</td><td>$0.020</td></tr>
      </table>
    </div>

    <!-- Business Valuation -->
    <div class="card" style="border-color:var(--primary)">
      <h3 style="color:var(--primary)">BUSINESS VALUATION ESTIMATE</h3>
      <p class="text-muted text-sm mb-4">Estimated worth if approached for acquisition. Based on SaaS industry multiples and asset valuation methods.</p>

      <!-- Method 1: Revenue Multiple -->
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div>
            <h4 style="font-size:15px;margin-bottom:4px;color:var(--text)">Method 1: ARR Revenue Multiple</h4>
            <p class="text-sm text-muted">SaaS companies valued at 3-10x Annual Recurring Revenue. Early-stage AI SaaS typically 5-8x.</p>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--text-muted)">RANGE</div>
            <div style="font-size:20px;font-weight:800;color:var(--primary)">RM 60K - 960K</div>
          </div>
        </div>
        <table style="margin-top:12px;font-size:13px">
          <tr><th>Scenario</th><th>MRR</th><th>ARR</th><th>Multiple</th><th style="text-align:right">Valuation</th></tr>
          <tr><td>Current (0 subscribers)</td><td>RM 0</td><td>RM 0</td><td>5x</td><td style="text-align:right">RM 0</td></tr>
          <tr><td>At 10 subscribers (Month 2)</td><td>RM 1,500</td><td>RM 18,000</td><td>5x</td><td style="text-align:right;color:var(--primary)">RM 90,000</td></tr>
          <tr><td>At 30 subscribers (Month 3)</td><td>RM 4,500</td><td>RM 54,000</td><td>5x</td><td style="text-align:right;color:var(--primary)">RM 270,000</td></tr>
          <tr style="background:rgba(46,196,182,0.05)"><td><strong>At 65 subscribers (target)</strong></td><td><strong>RM 10,500</strong></td><td><strong>RM 126,000</strong></td><td><strong>5x</strong></td><td style="text-align:right;color:var(--success);font-weight:800"><strong>RM 630,000</strong></td></tr>
          <tr><td>At 100 subscribers (scale)</td><td>RM 16,000</td><td>RM 192,000</td><td>5x</td><td style="text-align:right;color:var(--success);font-weight:800">RM 960,000</td></tr>
        </table>
      </div>

      <!-- Method 2: Asset-Based -->
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div>
            <h4 style="font-size:15px;margin-bottom:4px;color:var(--text)">Method 2: Asset / Rebuild Cost</h4>
            <p class="text-sm text-muted">What it would cost to rebuild this from scratch. Based on developer rates and timeline.</p>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--text-muted)">ESTIMATE</div>
            <div style="font-size:20px;font-weight:800;color:var(--primary)">RM 150K - 350K</div>
          </div>
        </div>
        <table style="margin-top:12px;font-size:13px">
          <tr><th>Asset</th><th>Details</th><th>Dev Time</th><th style="text-align:right">Value (RM)</th></tr>
          <tr><td>Full-stack codebase</td><td>7,779 lines, 30 files, 75 API endpoints</td><td>8-12 weeks</td><td style="text-align:right">RM 80,000</td></tr>
          <tr><td>AI integration layer</td><td>10 AI task handlers, Claude API, prompt engineering, cost tracking</td><td>3-4 weeks</td><td style="text-align:right">RM 40,000</td></tr>
          <tr><td>Multi-tenant auth system</td><td>User management, plans, bcrypt, sessions, role-based access</td><td>2-3 weeks</td><td style="text-align:right">RM 25,000</td></tr>
          <tr><td>Stripe billing integration</td><td>Checkout, subscriptions, trials, webhooks, plan enforcement</td><td>2 weeks</td><td style="text-align:right">RM 20,000</td></tr>
          <tr><td>Landing page + branding</td><td>Full marketing site, pricing, signup flow, contact form</td><td>1-2 weeks</td><td style="text-align:right">RM 15,000</td></tr>
          <tr><td>Super Sales Agent prompt</td><td>8 specialized skills, AIDA emails, SEO, cold call scripts</td><td>2-3 weeks</td><td style="text-align:right">RM 30,000</td></tr>
          <tr><td>Database schema (13 tables)</td><td>119 columns, foreign keys, user isolation, cost logging</td><td>1-2 weeks</td><td style="text-align:right">RM 15,000</td></tr>
          <tr><td>DevOps & deployment</td><td>Dockerfile, Railway config, health checks, rate limiting</td><td>1 week</td><td style="text-align:right">RM 10,000</td></tr>
          <tr style="font-weight:700;border-top:2px solid var(--border)">
            <td>TOTAL REBUILD COST</td><td>Senior full-stack dev @ RM 15-20K/mo</td><td>20-30 weeks</td>
            <td style="text-align:right;color:var(--primary);font-size:15px">RM 235,000</td>
          </tr>
        </table>
      </div>

      <!-- Method 3: Comparable Sales -->
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:start">
          <div>
            <h4 style="font-size:15px;margin-bottom:4px;color:var(--text)">Method 3: Comparable SaaS Acquisitions</h4>
            <p class="text-sm text-muted">Based on recent micro-SaaS acquisitions on MicroAcquire, Acquire.com, and Flippa.</p>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--text-muted)">MARKET RATE</div>
            <div style="font-size:20px;font-weight:800;color:var(--primary)">3-5x Monthly Profit</div>
          </div>
        </div>
        <table style="margin-top:12px;font-size:13px">
          <tr><th>Comparable</th><th>Type</th><th>Revenue</th><th>Sold For</th><th>Multiple</th></tr>
          <tr><td>AI writing tool (micro-SaaS)</td><td>Content gen</td><td>$2K MRR</td><td>$80K</td><td>3.3x ARR</td></tr>
          <tr><td>CRM with AI features</td><td>Sales tool</td><td>$5K MRR</td><td>$250K</td><td>4.2x ARR</td></tr>
          <tr><td>Email outreach SaaS</td><td>Sales automation</td><td>$8K MRR</td><td>$500K</td><td>5.2x ARR</td></tr>
          <tr><td>AI marketing platform</td><td>Marketing</td><td>$10K MRR</td><td>$800K</td><td>6.7x ARR</td></tr>
        </table>
        <div class="text-sm text-muted" style="margin-top:8px">Source: Acquire.com, MicroAcquire marketplace data (2025-2026 range)</div>
      </div>

      <!-- Summary -->
      <div style="background:rgba(46,196,182,0.08);border:1.5px solid var(--primary);border-radius:10px;padding:24px">
        <h4 style="font-size:16px;margin-bottom:12px;color:var(--primary)">Recommended Asking Price</h4>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px">
          <div style="text-align:center">
            <div style="font-size:12px;color:var(--text-muted)">MINIMUM (asset value)</div>
            <div style="font-size:24px;font-weight:800;color:var(--warning)">RM 150,000</div>
            <div style="font-size:11px;color:var(--text-muted)">Before any revenue</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:12px;color:var(--text-muted)">FAIR VALUE (with traction)</div>
            <div style="font-size:24px;font-weight:800;color:var(--primary)">RM 300,000</div>
            <div style="font-size:11px;color:var(--text-muted)">At 20-30 subscribers</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:12px;color:var(--text-muted)">PREMIUM (at target)</div>
            <div style="font-size:24px;font-weight:800;color:var(--success)">RM 630,000</div>
            <div style="font-size:11px;color:var(--text-muted)">At 65 subscribers, RM 10K/mo</div>
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-muted);line-height:1.8">
          <strong style="color:var(--text)">Justification:</strong><br>
          1. <strong>Working product</strong> — 75 API endpoints, 13 DB tables, full auth, billing, deployment. Not a prototype.<br>
          2. <strong>AI moat</strong> — Super Sales Agent with 8 specialized skills + AIDA emails + SEO + cold call conversion. Hard to replicate prompt engineering.<br>
          3. <strong>Revenue-ready</strong> — Stripe billing live, 3 subscription tiers, 14-day trials, auto account creation. Can accept payments TODAY.<br>
          4. <strong>Multi-tenant</strong> — Full user isolation, plan enforcement, budget controls. Ready for 100+ users.<br>
          5. <strong>Deployed</strong> — Live on Railway with Docker, health checks, auto-deploy from GitHub. Not localhost.<br>
          6. <strong>Malaysian market fit</strong> — Built for MY salespeople, MYR pricing, local SEO, APAC timezone. First-mover in this niche.<br>
          7. <strong>80%+ gross margins</strong> — AI costs ~RM 12-21/user vs RM 99-399 subscription. Highly profitable at scale.<br>
          8. <strong>Rebuild cost RM 235K+</strong> — 20-30 weeks of senior dev time. Buyer saves 6+ months vs building from scratch.
        </div>
      </div>
    </div>
  `;
}

// ========== Settings ==========
async function loadSettings() {
  try {
    const settings = await api.get('/settings');
    document.getElementById('page').innerHTML = `
      <div class="toolbar"><h2>Settings</h2></div>

      <div class="card">
        <h3>AI Configuration</h3>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          <span style="width:12px;height:12px;border-radius:50%;background:${settings._api_key_set ? 'var(--success)' : 'var(--danger)'};display:inline-block"></span>
          <span class="text-sm">${settings._api_key_set ? 'API key is configured' : 'No API key set — AI features will not work'}</span>
        </div>

        <div class="form-group">
          <label>AI Provider</label>
          <select id="s-provider">
            <option value="anthropic" ${settings.ai_provider === 'anthropic' ? 'selected' : ''}>Anthropic (Claude)</option>
          </select>
        </div>

        <div class="form-group">
          <label>AI Model</label>
          <select id="s-model">
            <option value="claude-sonnet-4-20250514" ${settings.ai_model === 'claude-sonnet-4-20250514' ? 'selected' : ''}>Claude Sonnet 4 (Recommended)</option>
            <option value="claude-opus-4-20250514" ${settings.ai_model === 'claude-opus-4-20250514' ? 'selected' : ''}>Claude Opus 4 (Most capable)</option>
            <option value="claude-haiku-4-5-20251001" ${settings.ai_model === 'claude-haiku-4-5-20251001' ? 'selected' : ''}>Claude Haiku 4.5 (Fastest)</option>
          </select>
        </div>

        <div class="form-group">
          <label>API Key</label>
          <div class="flex gap-2">
            <input id="s-apikey" type="password" value="${settings.api_key || ''}" placeholder="sk-ant-...">
            <button class="btn btn-outline btn-sm" onclick="document.getElementById('s-apikey').type = document.getElementById('s-apikey').type === 'password' ? 'text' : 'password'">Show</button>
          </div>
          <small class="text-muted">Get your API key from <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color:var(--primary)">console.anthropic.com</a></small>
        </div>

        <div class="form-group" style="margin-top:14px">
          <label>AI Credit Balance (USD)</label>
          <input id="s-ai-balance" type="number" step="0.01" value="${settings.ai_credit_balance || '5.00'}" placeholder="Enter your current Anthropic credit balance">
          <small class="text-muted">Update this after each top-up. Check balance at <a href="https://console.anthropic.com/settings/billing" target="_blank" style="color:var(--primary)">console.anthropic.com/billing</a></small>
        </div>

        <div class="flex gap-2" style="margin-top:16px">
          <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
          <button class="btn btn-outline" onclick="testAiConnection()">Test Connection</button>
        </div>
        <div id="settings-status" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <h3>Email / SMTP Configuration</h3>
        <div class="grid-2">
          <div class="form-group">
            <label>SMTP Host</label>
            <input id="s-smtp-host" value="${settings.smtp_host || ''}" placeholder="smtp.gmail.com">
          </div>
          <div class="form-group">
            <label>SMTP Port</label>
            <input id="s-smtp-port" type="number" value="${settings.smtp_port || '587'}" placeholder="587">
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>SMTP User</label>
            <input id="s-smtp-user" value="${settings.smtp_user || ''}" placeholder="your-email@gmail.com">
          </div>
          <div class="form-group">
            <label>SMTP Password</label>
            <input id="s-smtp-pass" type="password" value="${settings.smtp_pass || ''}" placeholder="App password">
          </div>
        </div>
        <div class="form-group">
          <label>From Email</label>
          <input id="s-from-email" value="${settings.from_email || ''}" placeholder="your-email@gmail.com">
        </div>
        <button class="btn btn-primary" onclick="saveSettings()" style="margin-top:12px">Save Settings</button>
      </div>

      <div class="card">
        <h3>Stripe / Billing</h3>
        <p class="text-muted text-sm mb-4">Connect your Stripe account for subscription billing. Get keys from <a href="https://dashboard.stripe.com/apikeys" target="_blank" style="color:var(--primary)">dashboard.stripe.com</a></p>
        <div class="form-group">
          <label>Stripe Secret Key</label>
          <div class="flex gap-2">
            <input id="s-stripe-secret" type="password" value="${settings.stripe_secret_key || ''}" placeholder="sk_live_...">
            <button class="btn btn-outline btn-sm" onclick="document.getElementById('s-stripe-secret').type = document.getElementById('s-stripe-secret').type === 'password' ? 'text' : 'password'">Show</button>
          </div>
        </div>
        <div class="form-group">
          <label>Stripe Publishable Key</label>
          <input id="s-stripe-pub" value="${settings.stripe_publishable_key || ''}" placeholder="pk_live_...">
        </div>
        <button class="btn btn-primary" onclick="saveSettings()" style="margin-top:12px">Save Settings</button>
      </div>

      <div class="card">
        <h3>Admin Security</h3>
        <p class="text-muted text-sm mb-4">This password protects the System Logic page (super admin access).</p>
        <div class="form-group">
          <label>Admin Password</label>
          <div class="flex gap-2">
            <input id="s-admin-pass" type="password" value="${settings.admin_password || ''}" placeholder="Admin password">
            <button class="btn btn-outline btn-sm" onclick="document.getElementById('s-admin-pass').type = document.getElementById('s-admin-pass').type === 'password' ? 'text' : 'password'">Show</button>
          </div>
        </div>
        <button class="btn btn-primary" onclick="saveSettings()" style="margin-top:12px">Save Settings</button>
      </div>
    `;
  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error loading settings: ${e.message}</div>`;
  }
}

async function saveSettings() {
  const data = {
    ai_provider: gv('s-provider'),
    ai_model: gv('s-model'),
    api_key: document.getElementById('s-apikey')?.value || '',
    smtp_host: gv('s-smtp-host'),
    smtp_port: gv('s-smtp-port'),
    smtp_user: gv('s-smtp-user'),
    smtp_pass: document.getElementById('s-smtp-pass')?.value || '',
    from_email: gv('s-from-email'),
    admin_password: document.getElementById('s-admin-pass')?.value || '',
    stripe_secret_key: document.getElementById('s-stripe-secret')?.value || '',
    stripe_publishable_key: gv('s-stripe-pub'),
    ai_credit_balance: gv('s-ai-balance') || '5.00',
  };

  try {
    await api.put('/settings', data);
    showNotification('Settings saved!', 'success');
    loadSettings();
  } catch (e) {
    showNotification('Error saving: ' + e.message, 'error');
  }
}

async function testAiConnection() {
  const statusEl = document.getElementById('settings-status');
  if (statusEl) statusEl.innerHTML = '<span class="text-muted">Testing connection...</span>';

  try {
    // Save first so the test uses latest key
    await saveSettings();
    const result = await api.post('/settings/test-ai');
    if (statusEl) {
      if (result.success) {
        statusEl.innerHTML = `<span style="color:var(--success)">Connected successfully! Model: ${result.model}</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:var(--danger)">Connection failed: ${result.error}</span>`;
      }
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger)">Error: ${e.message}</span>`;
  }
}

// ========== System Logic ==========
let slAdminPassword = '';
let slAuthenticated = true; // Auth handled by login now
let slActiveTopic = null;
let slAutoRefreshTimer = null;
let slLastHash = '';

function slAuthHeaders() {
  return {}; // Auth handled by bearer token now
}

async function loadSystemLogic() {
  // If not authenticated, show password gate
  if (!slAuthenticated) {
    document.getElementById('page').innerHTML = `
      <div style="max-width:400px;margin:80px auto;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">&#9883;</div>
        <h2 style="margin-bottom:8px">System Logic</h2>
        <p class="text-muted mb-4">Super Admin access required</p>
        <div class="card">
          <div class="form-group">
            <label>Admin Password</label>
            <input id="sl-password" type="password" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')slLogin()">
          </div>
          <div id="sl-auth-error" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none"></div>
          <button class="btn btn-primary" style="width:100%" onclick="slLogin()">Unlock</button>
          <p class="text-muted text-sm" style="margin-top:12px">Default password: admin123 &mdash; change it in Settings</p>
        </div>
      </div>
    `;
    setTimeout(() => document.getElementById('sl-password')?.focus(), 100);
    return;
  }

  // Authenticated — load the system logic page
  try {
    const data = await api.get('/system-logic', slAuthHeaders());
    if (data.error) { slAuthenticated = false; loadSystemLogic(); return; }

    const topics = Object.keys(data.grouped);
    if (!slActiveTopic || !topics.includes(slActiveTopic)) slActiveTopic = topics[0] || null;

    const topicEntries = slActiveTopic ? (data.grouped[slActiveTopic] || []) : [];

    // Compute a hash to detect changes
    const newHash = JSON.stringify(data.entries.map(e => e.updated_at));
    const changed = slLastHash && slLastHash !== newHash;
    slLastHash = newHash;

    document.getElementById('page').innerHTML = `
      <div class="toolbar">
        <h2>System Logic</h2>
        <div class="flex gap-2">
          <button class="btn btn-primary" onclick="slShowAddEntry()">+ Add Entry</button>
          <button class="btn btn-outline" onclick="slLock()">Lock</button>
          <div style="display:flex;align-items:center;gap:6px;margin-left:12px">
            <span style="width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block;animation:pulse 2s infinite"></span>
            <span class="text-sm text-muted">Auto-updating</span>
          </div>
        </div>
      </div>

      ${changed ? '<div style="background:rgba(59,130,246,0.15);border:1px solid var(--primary);border-radius:var(--radius);padding:10px 16px;margin-bottom:16px;font-size:13px">Content updated — changes detected from code.</div>' : ''}

      <div style="display:flex;gap:16px">
        <!-- Topic Sidebar -->
        <div style="min-width:200px">
          <div class="card" style="padding:12px">
            <h3 style="margin-bottom:12px">Topics</h3>
            ${topics.map(t => `
              <div class="nav-item ${slActiveTopic === t ? 'active' : ''}" style="padding:8px 12px;border-radius:6px;margin-bottom:2px;font-size:13px;border-right:none;${slActiveTopic === t ? 'background:rgba(59,130,246,0.15);color:var(--primary)' : ''}" onclick="slActiveTopic='${t}';loadSystemLogic()">
                ${t}
                <span class="badge badge-new" style="margin-left:auto">${(data.grouped[t] || []).length}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Entries -->
        <div style="flex:1">
          ${slActiveTopic ? `<h3 style="margin-bottom:12px;font-size:16px">${slActiveTopic}</h3>` : ''}
          ${topicEntries.length ? topicEntries.map(entry => `
            <div class="card" style="border-left:3px solid var(--primary)">
              <div style="display:flex;justify-content:space-between;align-items:flex-start">
                <div>
                  <h3 style="color:var(--text);text-transform:none;letter-spacing:0;font-size:15px;margin-bottom:4px">${escHtml(entry.title)}</h3>
                  ${entry.description ? `<p class="text-muted text-sm" style="margin-bottom:6px">${escHtml(entry.description)}</p>` : ''}
                  ${entry.code_ref ? `<code style="font-size:11px;background:var(--bg);padding:2px 6px;border-radius:4px;color:var(--primary)">${escHtml(entry.code_ref)}</code>` : ''}
                </div>
                <div class="flex gap-2">
                  <button class="btn btn-sm btn-outline" onclick="slEditEntry(${entry.id})">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="slDeleteEntry(${entry.id})">X</button>
                </div>
              </div>
              <div style="margin-top:12px;white-space:pre-wrap;font-size:13px;line-height:1.6;color:var(--text);background:var(--bg);padding:14px;border-radius:6px">${escHtml(entry.content)}</div>
              <div class="text-muted text-sm" style="margin-top:8px">Updated: ${new Date(entry.updated_at).toLocaleString()}</div>
            </div>
          `).join('') : '<div class="empty">No entries in this topic.</div>'}
        </div>
      </div>
    `;

    // Start auto-refresh polling
    slStartAutoRefresh();

  } catch (e) {
    document.getElementById('page').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function slLogin() {
  const pw = document.getElementById('sl-password')?.value;
  if (!pw) return;
  try {
    const result = await api.post('/system-logic/auth', { password: pw });
    if (result.success) {
      slAdminPassword = pw;
      slAuthenticated = true;
      sessionStorage.setItem('sl_admin_pw', pw);
      loadSystemLogic();
    } else {
      const errEl = document.getElementById('sl-auth-error');
      if (errEl) { errEl.textContent = 'Wrong password'; errEl.style.display = 'block'; }
    }
  } catch (e) {
    const errEl = document.getElementById('sl-auth-error');
    if (errEl) { errEl.textContent = 'Connection error'; errEl.style.display = 'block'; }
  }
}

function slLock() {
  slAuthenticated = false;
  slAdminPassword = '';
  sessionStorage.removeItem('sl_admin_pw');
  slStopAutoRefresh();
  loadSystemLogic();
}

function slStartAutoRefresh() {
  slStopAutoRefresh();
  slAutoRefreshTimer = setInterval(async () => {
    if (currentPage !== 'system-logic' || !slAuthenticated) { slStopAutoRefresh(); return; }
    // Silently re-fetch and check for changes
    try {
      const data = await api.get('/system-logic', slAuthHeaders());
      if (data.error) return;
      const newHash = JSON.stringify(data.entries.map(e => e.updated_at));
      if (newHash !== slLastHash) {
        loadSystemLogic(); // Re-render with change indicator
      }
    } catch (e) { /* silent */ }
  }, 3000); // Poll every 3 seconds
}

function slStopAutoRefresh() {
  if (slAutoRefreshTimer) { clearInterval(slAutoRefreshTimer); slAutoRefreshTimer = null; }
}

async function slShowAddEntry() {
  const topicsData = await api.get('/system-logic/topics', slAuthHeaders());
  const existingTopics = topicsData.map ? topicsData.map(t => t.topic) : [];

  modal = {
    title: 'Add System Logic Entry',
    body: `
      <div class="form-group">
        <label>Topic</label>
        <input id="sl-topic" list="sl-topics" value="${slActiveTopic || ''}" placeholder="e.g., AI Engine, API Layer, Services">
        <datalist id="sl-topics">${existingTopics.map(t => `<option value="${t}">`).join('')}</datalist>
      </div>
      <div class="form-group"><label>Title</label><input id="sl-title" placeholder="Entry title"></div>
      <div class="form-group"><label>Description</label><input id="sl-desc" placeholder="Short description"></div>
      <div class="form-group"><label>Code Reference</label><input id="sl-coderef" placeholder="e.g., src/services/ai-agent.js"></div>
      <div class="form-group"><label>Content</label><textarea id="sl-content" style="min-height:150px" placeholder="Detailed explanation of how this part of the system works"></textarea></div>
      <div class="form-group"><label>Sort Order</label><input id="sl-sort" type="number" value="0"></div>
    `,
    onSave: async () => {
      await api.post('/system-logic', {
        topic: gv('sl-topic'), title: gv('sl-title'), description: gv('sl-desc'),
        code_ref: gv('sl-coderef'), content: gv('sl-content'), sort_order: parseInt(gv('sl-sort') || '0'),
      }, slAuthHeaders());
      modal = null;
      slActiveTopic = gv('sl-topic') || slActiveTopic;
      navigate('system-logic');
    },
  };
  render();
}

async function slEditEntry(id) {
  const entry = await api.get(`/system-logic/${id}`, slAuthHeaders());
  if (entry.error) { showNotification(entry.error, 'error'); return; }

  const topicsData = await api.get('/system-logic/topics', slAuthHeaders());
  const existingTopics = topicsData.map ? topicsData.map(t => t.topic) : [];

  modal = {
    title: 'Edit System Logic Entry',
    body: `
      <div class="form-group">
        <label>Topic</label>
        <input id="sl-topic" list="sl-topics" value="${entry.topic}" placeholder="e.g., AI Engine">
        <datalist id="sl-topics">${existingTopics.map(t => `<option value="${t}">`).join('')}</datalist>
      </div>
      <div class="form-group"><label>Title</label><input id="sl-title" value="${escHtml(entry.title)}"></div>
      <div class="form-group"><label>Description</label><input id="sl-desc" value="${escHtml(entry.description || '')}"></div>
      <div class="form-group"><label>Code Reference</label><input id="sl-coderef" value="${escHtml(entry.code_ref || '')}"></div>
      <div class="form-group"><label>Content</label><textarea id="sl-content" style="min-height:150px">${escHtml(entry.content)}</textarea></div>
      <div class="form-group"><label>Sort Order</label><input id="sl-sort" type="number" value="${entry.sort_order}"></div>
    `,
    onSave: async () => {
      await api.put(`/system-logic/${id}`, {
        topic: gv('sl-topic'), title: gv('sl-title'), description: gv('sl-desc'),
        code_ref: gv('sl-coderef'), content: gv('sl-content'), sort_order: parseInt(gv('sl-sort') || '0'),
      }, slAuthHeaders());
      modal = null;
      slActiveTopic = gv('sl-topic') || slActiveTopic;
      navigate('system-logic');
    },
  };
  render();
}

async function slDeleteEntry(id) {
  if (!confirm('Delete this system logic entry?')) return;
  await api.del(`/system-logic/${id}`, slAuthHeaders());
  loadSystemLogic();
}

// ========== Init ==========
async function init() {
  // Handle post-signup redirect from Stripe
  const params = new URLSearchParams(window.location.search);
  if (params.get('welcome') === '1' && params.get('token')) {
    authToken = params.get('token');
    sessionStorage.setItem('auth_token', authToken);
    // Clean URL
    window.history.replaceState({}, '', '/app');
  }

  if (authToken) {
    try {
      currentUser = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${authToken}` }
      }).then(r => r.json());
      if (currentUser.error) throw new Error();
    } catch {
      authToken = null; currentUser = null;
      sessionStorage.removeItem('auth_token');
    }
  }
  render();

  // Show welcome modal for new signups
  if (params.get('welcome') === '1' && currentUser) {
    const tempPass = params.get('tempPassword');
    modal = {
      title: 'Welcome to EIAAW SalesAgent!',
      body: `
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:48px;margin-bottom:8px">&#127881;</div>
          <p style="color:var(--primary);font-weight:600">Your account is ready!</p>
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:16px;margin-bottom:16px">
          <p class="text-sm text-muted" style="margin-bottom:8px">Your login credentials:</p>
          <div style="margin-bottom:8px"><strong>Username:</strong> ${esc(currentUser.username)}</div>
          <div style="margin-bottom:8px"><strong>Email:</strong> ${esc(currentUser.email)}</div>
          ${tempPass ? `<div style="margin-bottom:8px"><strong>Temporary Password:</strong> <code style="background:var(--surface2);padding:2px 8px;border-radius:4px">${esc(tempPass)}</code></div>` : ''}
          <div><strong>Plan:</strong> <span class="badge badge-active">${esc((currentUser.plan || 'starter').toUpperCase())}</span> — 14-day free trial</div>
        </div>
        ${tempPass ? `<div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:12px;font-size:13px;color:var(--warning)">
          <strong>Important:</strong> Save your password now and change it in Settings. You'll need it to log in next time.
        </div>` : ''}
        <div style="margin-top:16px">
          <p class="text-sm text-muted">What to do next:</p>
          <ol style="font-size:13px;color:var(--text-muted);padding-left:20px;margin-top:8px;line-height:2">
            <li>Create your first campaign</li>
            <li>Let AI find leads for you</li>
            <li>Launch auto-outreach</li>
            <li>Watch the deals come in!</li>
          </ol>
        </div>
      `,
      onSave: () => { modal = null; navigate('campaigns'); },
      saveLabel: 'Get Started',
    };
    render();
  }
}
init();
