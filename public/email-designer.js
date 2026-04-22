// ============================================================
// EIAAW Email Designer
// ------------------------------------------------------------
// Embedded inside the campaign wizard's "Content" step (email type only).
// Three tabs: Templates / Build from Scratch / AI Generate.
// State lives at wizardState.data.design (see app.js).
// On every change, compileEmail(design) writes final HTML into
// wizardState.data.body so the existing send/launch pipeline keeps working.
// ============================================================

(function () {
  'use strict';

  // ------------- Helpers ----------------------------------------------------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // For attribute values we still need quote escaping but allow ampersands intact
  const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');

  function uid() { return 'b' + Math.random().toString(36).slice(2, 9); }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  // Brand defaults — EIAAW design system
  const FONT_OPTIONS = [
    { v: "'Inter', Arial, Helvetica, sans-serif", label: 'Inter (Modern)' },
    { v: "'Helvetica Neue', Helvetica, Arial, sans-serif", label: 'Helvetica' },
    { v: "Georgia, 'Times New Roman', serif", label: 'Georgia (Serif)' },
    { v: "'Instrument Serif', Georgia, serif", label: 'Instrument Serif (Editorial)' },
    { v: "'Trebuchet MS', sans-serif", label: 'Trebuchet' },
    { v: "Verdana, Geneva, sans-serif", label: 'Verdana' },
    { v: "Tahoma, Geneva, sans-serif", label: 'Tahoma' },
  ];

  const BTN_SIZES = {
    sm: { padY: 10, padX: 18, font: 13 },
    md: { padY: 14, padX: 26, font: 15 },
    lg: { padY: 18, padX: 36, font: 17 },
  };

  // Default design — used when creating from scratch
  function defaultDesign() {
    return {
      mode: 'scratch', // 'scratch' | 'template' | 'ai'
      brand: {
        logoUrl: '',         // absolute URL after upload
        primaryColor: '#1FA896',
        accentColor: '#11766A',
        font: FONT_OPTIONS[0].v,
        bgColor: '#FAF7F2',
        textColor: '#0F1A1D',
      },
      header: {
        show: true,
        align: 'center',     // 'left' | 'center' | 'right'
        bannerUrl: '',
        bannerHeight: 0,
      },
      blocks: [
        { id: uid(), type: 'h1', text: 'Welcome', align: 'left' },
        { id: uid(), type: 'p',  text: 'Write your message here. Tell your reader what this email is about and why it matters to them.', align: 'left' },
      ],
      footer: {
        show: true,
        companyName: 'Your Company',
        address: '',
        phone: '',
        social: { facebook: '', instagram: '', linkedin: '', x: '', youtube: '' },
        unsubscribeText: 'Unsubscribe from these emails',
        unsubscribeUrl: '{{unsubscribe_url}}',
      },
    };
  }

  // ------------- Public API -------------------------------------------------
  let __rootId = 'ed-root';
  window.EmailDesigner = {
    defaultDesign,
    render: renderDesigner,
    compile: compileEmail,
    openPreview: openPreview,
  };

  // ------------- Rendering --------------------------------------------------
  function renderDesigner(containerId) {
    if (containerId) __rootId = containerId;
    const root = document.getElementById(__rootId);
    if (!root) return;
    const d = ensureDesign();

    root.innerHTML = `
      <div class="ed-tabs">
        <button class="ed-tab ${d.mode === 'template' ? 'active' : ''}" onclick="EmailDesigner_setMode('template')">&#9783; Templates</button>
        <button class="ed-tab ${d.mode === 'scratch' ? 'active' : ''}"  onclick="EmailDesigner_setMode('scratch')">&#9881; Build from Scratch</button>
        <button class="ed-tab ${d.mode === 'ai' ? 'active' : ''}"       onclick="EmailDesigner_setMode('ai')">&#9728; AI Generate</button>
        <div style="flex:1"></div>
        <button class="btn btn-outline btn-sm" onclick="EmailDesigner_preview()" type="button">&#128065; Preview</button>
      </div>

      <div class="ed-body">
        ${d.mode === 'template' ? renderTemplatesTab() : ''}
        ${d.mode === 'scratch'  ? renderScratchTab()  : ''}
        ${d.mode === 'ai'       ? renderAiTab()       : ''}
      </div>

      <div class="ed-footnote">
        <small>Every email automatically includes the EIAAW Solutions footer to maintain trust + deliverability.</small>
      </div>
    `;

    syncCompiledBody();
  }

  // ------------- Tabs -------------------------------------------------------
  function renderTemplatesTab() {
    const cats = window.EmailTemplates ? window.EmailTemplates.categories() : [];
    return `
      <div class="ed-tpl-cats">
        ${cats.map(c => `
          <div class="ed-tpl-cat">
            <h4>${esc(c.label)}</h4>
            <div class="ed-tpl-grid">
              ${c.templates.map(t => `
                <button class="ed-tpl-card" onclick="EmailDesigner_useTemplate('${c.id}','${t.id}')" type="button">
                  <div class="ed-tpl-thumb" style="background:${t.thumbBg || '#F3EDE0'};color:${t.thumbInk || '#0F1A1D'}">
                    <span>${esc(t.thumbLabel || t.name.split(' ')[0])}</span>
                  </div>
                  <div class="ed-tpl-name">${esc(t.name)}</div>
                </button>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderScratchTab() {
    const d = ensureDesign();
    return `
      <div class="ed-scratch-grid">
        <div class="ed-side">
          <div class="ed-section">
            <h4>&#9883; Brand</h4>
            <label>Logo</label>
            <div class="ed-logo-row">
              ${d.brand.logoUrl ? `<img src="${escAttr(d.brand.logoUrl)}" alt="Logo" class="ed-logo-thumb">` : '<div class="ed-logo-thumb empty">No logo</div>'}
              <div class="flex-col">
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" onchange="EmailDesigner_uploadLogo(this)" id="ed-logo-input" style="display:none">
                <button class="btn btn-sm btn-outline" type="button" onclick="document.getElementById('ed-logo-input').click()">${d.brand.logoUrl ? 'Change' : 'Upload'} Logo</button>
                ${d.brand.logoUrl ? `<button class="btn btn-sm btn-link" type="button" onclick="EmailDesigner_setBrand('logoUrl','')">Remove</button>` : ''}
              </div>
            </div>

            <label>Brand color</label>
            <div class="ed-color-row">
              <input type="color" value="${escAttr(d.brand.primaryColor)}" oninput="EmailDesigner_setBrand('primaryColor', this.value)">
              <input type="text" value="${escAttr(d.brand.primaryColor)}" oninput="EmailDesigner_setBrand('primaryColor', this.value)">
            </div>

            <label>Accent color</label>
            <div class="ed-color-row">
              <input type="color" value="${escAttr(d.brand.accentColor)}" oninput="EmailDesigner_setBrand('accentColor', this.value)">
              <input type="text" value="${escAttr(d.brand.accentColor)}" oninput="EmailDesigner_setBrand('accentColor', this.value)">
            </div>

            <label>Background</label>
            <div class="ed-color-row">
              <input type="color" value="${escAttr(d.brand.bgColor)}" oninput="EmailDesigner_setBrand('bgColor', this.value)">
              <input type="text" value="${escAttr(d.brand.bgColor)}" oninput="EmailDesigner_setBrand('bgColor', this.value)">
            </div>

            <label>Text color</label>
            <div class="ed-color-row">
              <input type="color" value="${escAttr(d.brand.textColor)}" oninput="EmailDesigner_setBrand('textColor', this.value)">
              <input type="text" value="${escAttr(d.brand.textColor)}" oninput="EmailDesigner_setBrand('textColor', this.value)">
            </div>

            <label>Font family</label>
            <select onchange="EmailDesigner_setBrand('font', this.value)">
              ${FONT_OPTIONS.map(f => `<option value="${escAttr(f.v)}" ${f.v === d.brand.font ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
            </select>
          </div>

          <div class="ed-section">
            <h4>&#9776; Header</h4>
            <label class="checkbox-row">
              <input type="checkbox" ${d.header.show ? 'checked' : ''} onchange="EmailDesigner_setHeader('show', this.checked)">
              Show header (logo)
            </label>
            <label>Logo alignment</label>
            <select onchange="EmailDesigner_setHeader('align', this.value)">
              <option value="left"   ${d.header.align === 'left' ? 'selected' : ''}>Left</option>
              <option value="center" ${d.header.align === 'center' ? 'selected' : ''}>Center</option>
              <option value="right"  ${d.header.align === 'right' ? 'selected' : ''}>Right</option>
            </select>
          </div>

          <div class="ed-section">
            <h4>&#10010; Add block</h4>
            <div class="ed-block-add">
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('h1')">H1</button>
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('h2')">H2</button>
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('h3')">H3</button>
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('p')">Paragraph</button>
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('image')">Image</button>
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('divider')">Divider</button>
              <button class="btn btn-sm btn-outline" type="button" onclick="EmailDesigner_addBlock('spacer')">Spacer</button>
            </div>
          </div>

          <div class="ed-section">
            <h4>&#9636; Footer</h4>
            <label class="checkbox-row">
              <input type="checkbox" ${d.footer.show ? 'checked' : ''} onchange="EmailDesigner_setFooter('show', this.checked)">
              Show your company footer
            </label>
            <label>Company name</label>
            <input type="text" value="${escAttr(d.footer.companyName)}" oninput="EmailDesigner_setFooter('companyName', this.value)">
            <label>Address</label>
            <input type="text" value="${escAttr(d.footer.address)}" oninput="EmailDesigner_setFooter('address', this.value)">
            <label>Phone</label>
            <input type="text" value="${escAttr(d.footer.phone)}" oninput="EmailDesigner_setFooter('phone', this.value)">
            <label>Social links (full URL)</label>
            <input type="text" placeholder="Facebook URL"  value="${escAttr(d.footer.social.facebook)}"  oninput="EmailDesigner_setSocial('facebook', this.value)">
            <input type="text" placeholder="Instagram URL" value="${escAttr(d.footer.social.instagram)}" oninput="EmailDesigner_setSocial('instagram', this.value)">
            <input type="text" placeholder="LinkedIn URL"  value="${escAttr(d.footer.social.linkedin)}"  oninput="EmailDesigner_setSocial('linkedin', this.value)">
            <input type="text" placeholder="X / Twitter URL" value="${escAttr(d.footer.social.x)}"        oninput="EmailDesigner_setSocial('x', this.value)">
            <input type="text" placeholder="YouTube URL"   value="${escAttr(d.footer.social.youtube)}"   oninput="EmailDesigner_setSocial('youtube', this.value)">
            <label>Unsubscribe label</label>
            <input type="text" value="${escAttr(d.footer.unsubscribeText)}" oninput="EmailDesigner_setFooter('unsubscribeText', this.value)">
          </div>
        </div>

        <div class="ed-canvas">
          <div class="ed-canvas-head">
            <strong>Layout</strong>
            <span class="text-muted text-sm">Drag blocks up/down with the arrows</span>
          </div>
          <div class="ed-blocks">
            ${d.blocks.map((b, i) => renderBlockEditor(b, i, d.blocks.length)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderBlockEditor(b, i, total) {
    const common = `
      <div class="ed-block-toolbar">
        <span class="ed-block-type">${b.type.toUpperCase()}</span>
        <div class="flex-1"></div>
        <button type="button" class="btn-icon" onclick="EmailDesigner_moveBlock(${i}, -1)" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
        <button type="button" class="btn-icon" onclick="EmailDesigner_moveBlock(${i},  1)" ${i === total - 1 ? 'disabled' : ''}>&#9660;</button>
        <button type="button" class="btn-icon danger" onclick="EmailDesigner_deleteBlock(${i})">&times;</button>
      </div>
    `;

    switch (b.type) {
      case 'h1':
      case 'h2':
      case 'h3':
        return `<div class="ed-block">
          ${common}
          <input type="text" class="ed-block-input" value="${escAttr(b.text)}" oninput="EmailDesigner_updateBlock(${i}, 'text', this.value)">
          <div class="ed-block-meta">
            <label>Align
              <select onchange="EmailDesigner_updateBlock(${i}, 'align', this.value)">
                <option value="left"   ${b.align === 'left' ? 'selected' : ''}>Left</option>
                <option value="center" ${b.align === 'center' ? 'selected' : ''}>Center</option>
                <option value="right"  ${b.align === 'right' ? 'selected' : ''}>Right</option>
              </select>
            </label>
          </div>
        </div>`;

      case 'p':
        return `<div class="ed-block">
          ${common}
          <textarea class="ed-block-input" rows="4" oninput="EmailDesigner_updateBlock(${i}, 'text', this.value)">${esc(b.text)}</textarea>
          <div class="ed-block-meta">
            <label>Align
              <select onchange="EmailDesigner_updateBlock(${i}, 'align', this.value)">
                <option value="left"   ${b.align === 'left' ? 'selected' : ''}>Left</option>
                <option value="center" ${b.align === 'center' ? 'selected' : ''}>Center</option>
                <option value="right"  ${b.align === 'right' ? 'selected' : ''}>Right</option>
              </select>
            </label>
          </div>
        </div>`;

      case 'image':
        return `<div class="ed-block">
          ${common}
          <div class="ed-img-row">
            ${b.url ? `<img src="${escAttr(b.url)}" alt="" class="ed-img-thumb">` : '<div class="ed-img-thumb empty">No image</div>'}
            <div class="flex-col">
              <input type="text" placeholder="Image URL (https://...)" value="${escAttr(b.url || '')}" oninput="EmailDesigner_updateBlock(${i}, 'url', this.value)">
              <input type="file" accept="image/*" id="ed-img-${i}" style="display:none" onchange="EmailDesigner_uploadBlockImage(${i}, this)">
              <button type="button" class="btn btn-sm btn-outline" onclick="document.getElementById('ed-img-${i}').click()">Upload image</button>
              <input type="text" placeholder="Alt text" value="${escAttr(b.alt || '')}" oninput="EmailDesigner_updateBlock(${i}, 'alt', this.value)">
            </div>
          </div>
        </div>`;

      case 'cta':
        return `<div class="ed-block">
          ${common}
          <input type="text" class="ed-block-input" placeholder="Button text" value="${escAttr(b.text)}" oninput="EmailDesigner_updateBlock(${i}, 'text', this.value)">
          <input type="text" class="ed-block-input" placeholder="Destination URL (https://...)" value="${escAttr(b.url)}" oninput="EmailDesigner_updateBlock(${i}, 'url', this.value)">
          <div class="ed-block-meta cta-meta">
            <label>Font
              <select onchange="EmailDesigner_updateBlock(${i}, 'font', this.value)">
                ${FONT_OPTIONS.map(f => `<option value="${escAttr(f.v)}" ${f.v === b.font ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
              </select>
            </label>
            <label>Size
              <select onchange="EmailDesigner_updateBlock(${i}, 'size', this.value)">
                <option value="sm" ${b.size === 'sm' ? 'selected' : ''}>Small</option>
                <option value="md" ${b.size === 'md' ? 'selected' : ''}>Medium</option>
                <option value="lg" ${b.size === 'lg' ? 'selected' : ''}>Large</option>
              </select>
            </label>
            <label>Align
              <select onchange="EmailDesigner_updateBlock(${i}, 'align', this.value)">
                <option value="left"   ${b.align === 'left' ? 'selected' : ''}>Left</option>
                <option value="center" ${b.align === 'center' ? 'selected' : ''}>Center</option>
                <option value="right"  ${b.align === 'right' ? 'selected' : ''}>Right</option>
              </select>
            </label>
            <label>Bg
              <input type="color" value="${escAttr(b.bg)}" oninput="EmailDesigner_updateBlock(${i}, 'bg', this.value)">
            </label>
            <label>Text
              <input type="color" value="${escAttr(b.color)}" oninput="EmailDesigner_updateBlock(${i}, 'color', this.value)">
            </label>
          </div>
        </div>`;

      case 'divider':
        return `<div class="ed-block">${common}<div class="ed-divider-preview"></div></div>`;

      case 'spacer':
        return `<div class="ed-block">${common}
          <label>Height (px)
            <input type="number" min="8" max="120" value="${b.height || 24}" oninput="EmailDesigner_updateBlock(${i}, 'height', parseInt(this.value)||24)">
          </label>
        </div>`;

      default:
        return '';
    }
  }

  function renderAiTab() {
    return `
      <div class="ed-ai">
        <p>Let AI write your email based on your campaign target audience and subject line. The result is poured into the <strong>Build from Scratch</strong> editor so you can refine it before sending.</p>
        <div class="form-group">
          <label>Tone</label>
          <select id="ed-ai-tone">
            <option value="professional">Professional</option>
            <option value="friendly">Friendly</option>
            <option value="urgent">Urgent</option>
            <option value="casual">Casual</option>
            <option value="luxury">Luxury / Premium</option>
          </select>
        </div>
        <div class="form-group">
          <label>Purpose</label>
          <select id="ed-ai-purpose">
            <option value="promotional">Promotional</option>
            <option value="welcome">Welcome</option>
            <option value="follow-up">Follow-up</option>
            <option value="re-engagement">Re-engagement</option>
            <option value="announcement">Announcement</option>
            <option value="event invite">Event invite</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="EmailDesigner_runAi()" id="ed-ai-btn" type="button">&#9889; Generate with AI</button>
      </div>
    `;
  }

  // ------------- State accessors -------------------------------------------
  function ensureDesign() {
    if (!window.wizardState) return defaultDesign();
    if (!window.wizardState.data) window.wizardState.data = {};
    if (!window.wizardState.data.design) {
      window.wizardState.data.design = defaultDesign();
    }
    return window.wizardState.data.design;
  }

  function syncCompiledBody() {
    if (!window.wizardState) return;
    const html = compileEmail(ensureDesign());
    window.wizardState.data.body = html;
  }

  // Re-render only the canvas (not the side panel) so input focus is preserved
  function rerenderCanvas() {
    const d = ensureDesign();
    const root = document.getElementById(__rootId);
    const canvas = root && root.querySelector('.ed-blocks');
    if (canvas) {
      canvas.innerHTML = d.blocks.map((b, i) => renderBlockEditor(b, i, d.blocks.length)).join('');
    }
    syncCompiledBody();
  }

  // ------------- Event handlers (exposed via window) ------------------------
  window.EmailDesigner_setMode = function (mode) {
    const d = ensureDesign();
    d.mode = mode;
    renderDesigner(__rootId);
  };

  window.EmailDesigner_setBrand = function (k, v) {
    const d = ensureDesign(); d.brand[k] = v; syncCompiledBody();
  };
  window.EmailDesigner_setHeader = function (k, v) {
    const d = ensureDesign(); d.header[k] = v; syncCompiledBody();
  };
  window.EmailDesigner_setFooter = function (k, v) {
    const d = ensureDesign(); d.footer[k] = v; syncCompiledBody();
  };
  window.EmailDesigner_setSocial = function (k, v) {
    const d = ensureDesign(); d.footer.social[k] = v; syncCompiledBody();
  };

  window.EmailDesigner_addBlock = function (type) {
    const d = ensureDesign();
    const def = {
      h1: { id: uid(), type: 'h1', text: 'Heading', align: 'left' },
      h2: { id: uid(), type: 'h2', text: 'Subheading', align: 'left' },
      h3: { id: uid(), type: 'h3', text: 'Section title', align: 'left' },
      p:  { id: uid(), type: 'p',  text: 'New paragraph.', align: 'left' },
      image:   { id: uid(), type: 'image', url: '', alt: '' },
      divider: { id: uid(), type: 'divider' },
      spacer:  { id: uid(), type: 'spacer', height: 24 },
    }[type];
    if (def) d.blocks.push(def);
    rerenderCanvas();
  };

  window.EmailDesigner_updateBlock = function (i, k, v) {
    const d = ensureDesign();
    if (!d.blocks[i]) return;
    d.blocks[i][k] = v;
    syncCompiledBody();
  };

  window.EmailDesigner_moveBlock = function (i, delta) {
    const d = ensureDesign();
    const j = i + delta;
    if (j < 0 || j >= d.blocks.length) return;
    const [b] = d.blocks.splice(i, 1);
    d.blocks.splice(j, 0, b);
    rerenderCanvas();
  };

  window.EmailDesigner_deleteBlock = function (i) {
    const d = ensureDesign();
    d.blocks.splice(i, 1);
    rerenderCanvas();
  };

  window.EmailDesigner_uploadLogo = async function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 1_500_000) {
      alert('Logo too large. Max 1.5MB.');
      input.value = '';
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    try {
      const r = await window.api.post('/uploads/logo', { dataUrl, filename: file.name });
      const d = ensureDesign();
      d.brand.logoUrl = r.url;
      renderDesigner(__rootId);
    } catch (e) {
      alert('Upload failed: ' + e.message);
    } finally {
      input.value = '';
    }
  };

  window.EmailDesigner_uploadBlockImage = async function (i, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 1_500_000) {
      alert('Image too large. Max 1.5MB.');
      input.value = '';
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    try {
      const r = await window.api.post('/uploads/logo', { dataUrl, filename: file.name });
      const d = ensureDesign();
      if (d.blocks[i]) d.blocks[i].url = r.url;
      rerenderCanvas();
    } catch (e) {
      alert('Upload failed: ' + e.message);
    } finally {
      input.value = '';
    }
  };

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  window.EmailDesigner_useTemplate = function (catId, tplId) {
    if (!window.EmailTemplates) return;
    const tpl = window.EmailTemplates.get(catId, tplId);
    if (!tpl) return;
    const d = ensureDesign();
    // Preserve user's brand + footer so templates feel personal
    const newDesign = tpl.build({
      brand: clone(d.brand),
      footer: clone(d.footer),
    });
    newDesign.mode = 'scratch'; // Drop the user into the editor for tweaking
    window.wizardState.data.design = newDesign;
    renderDesigner(__rootId);
  };

  window.EmailDesigner_runAi = async function () {
    const btn = document.getElementById('ed-ai-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
    try {
      const tone = document.getElementById('ed-ai-tone')?.value || 'professional';
      const purpose = document.getElementById('ed-ai-purpose')?.value || 'promotional';
      const data = window.wizardState?.data || {};
      const result = await window.api.post('/agent/generate/email', {
        audience: data.target_audience || '',
        subject: data.subject || '',
        purpose, tone,
      });
      if (result.subject) window.wizardState.data.subject = result.subject;

      const d = ensureDesign();
      // Drop the AI-generated HTML into a single "html" block, plus a starter heading
      d.blocks = [
        { id: uid(), type: 'h1', text: result.subject || data.subject || 'Hello there', align: 'left' },
        { id: uid(), type: 'html', html: result.body_html || `<p>${esc(result.body_text || '')}</p>` },
      ];
      d.mode = 'scratch';
      renderDesigner(__rootId);
      if (window.showNotification) window.showNotification('AI content generated! Edit it as you like.', 'success');
    } catch (e) {
      alert('AI error: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Generate with AI'; }
    }
  };

  window.EmailDesigner_preview = function () { openPreview(ensureDesign()); };

  // ------------- Compile to email HTML --------------------------------------
  function compileEmail(d) {
    if (!d) d = defaultDesign();
    const brand = d.brand;
    const safeFont = brand.font || FONT_OPTIONS[0].v;

    // ---- Header ------------------------------------------------------------
    let headerHtml = '';
    if (d.header.show && brand.logoUrl) {
      const align = d.header.align || 'center';
      headerHtml = `
        <tr>
          <td align="${align}" style="padding:24px 24px 8px 24px;">
            <img src="${escAttr(brand.logoUrl)}" alt="${escAttr(d.footer.companyName || 'Logo')}" style="max-height:54px;max-width:240px;display:inline-block;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>`;
    }

    // ---- Body blocks -------------------------------------------------------
    const blocksHtml = (d.blocks || []).map(b => renderBlockHtml(b, brand)).join('\n');

    // ---- User footer -------------------------------------------------------
    let userFooterHtml = '';
    if (d.footer.show) {
      const f = d.footer;
      const socialIcons = [
        { k: 'facebook',  label: 'FB', url: f.social.facebook },
        { k: 'instagram', label: 'IG', url: f.social.instagram },
        { k: 'linkedin',  label: 'in', url: f.social.linkedin },
        { k: 'x',         label: 'X',  url: f.social.x },
        { k: 'youtube',   label: 'YT', url: f.social.youtube },
      ].filter(s => s.url).map(s => `
        <a href="${escAttr(s.url)}" style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;background:${escAttr(brand.accentColor)};color:#fff;border-radius:50%;text-decoration:none;font-size:12px;font-weight:600;margin:0 4px;">${esc(s.label)}</a>
      `).join('');

      userFooterHtml = `
        <tr>
          <td style="padding:32px 24px 12px 24px;border-top:1px solid #E8DFCC;text-align:center;font-family:${escAttr(safeFont)};color:#6B7A7F;font-size:13px;line-height:1.6;">
            ${f.companyName ? `<div style="font-weight:600;color:#0F1A1D;font-size:14px;margin-bottom:4px;">${esc(f.companyName)}</div>` : ''}
            ${f.address ? `<div>${esc(f.address)}</div>` : ''}
            ${f.phone ? `<div>${esc(f.phone)}</div>` : ''}
            ${socialIcons ? `<div style="margin-top:14px;">${socialIcons}</div>` : ''}
            ${f.unsubscribeUrl ? `<div style="margin-top:14px;font-size:12px;"><a href="${escAttr(f.unsubscribeUrl)}" style="color:#6B7A7F;text-decoration:underline;">${esc(f.unsubscribeText || 'Unsubscribe')}</a></div>` : ''}
          </td>
        </tr>`;
    }

    // ---- Locked EIAAW footer (always rendered) ----------------------------
    const baseUrl = (window.location && window.location.origin) || 'https://sa.eiaawsolutions.com';
    const shieldUrl = `${baseUrl}/brand/shield.png`;
    const eiaawFooter = `
        <tr>
          <td style="padding:18px 24px 28px 24px;text-align:center;font-family:${escAttr(safeFont)};color:#6B7A7F;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle;padding-right:8px;">
                  <img src="${shieldUrl}" alt="EIAAW Solutions" width="22" height="22" style="display:block;border:0;outline:none;">
                </td>
                <td style="vertical-align:middle;font-family:${escAttr(safeFont)};font-size:11px;color:#11766A;font-weight:700;letter-spacing:0.12em;">
                  Powered by EIAAW SOLUTIONS
                </td>
              </tr>
            </table>
            <div style="margin-top:6px;font-size:10px;color:#6B7A7F;letter-spacing:0.14em;">AI &middot; Human Partnerships</div>
          </td>
        </tr>`;

    // ---- Wrap in email-safe table layout ----------------------------------
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(d.subject || 'Email')}</title>
<style>
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { -ms-interpolation-mode:bicubic; }
  body { margin:0 !important; padding:0 !important; width:100% !important; background:${escAttr(brand.bgColor)}; }
  .ed-wrap { width:100%; background:${escAttr(brand.bgColor)}; }
  .ed-card { width:600px; max-width:600px; background:#FFFFFF; }
  @media screen and (max-width:620px) {
    .ed-card { width:100% !important; }
    .ed-cta-md { padding:12px 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${escAttr(brand.bgColor)};font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};">
<table role="presentation" class="ed-wrap" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${escAttr(brand.bgColor)};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" class="ed-card" cellpadding="0" cellspacing="0" border="0" width="600" style="background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,26,29,0.06);">
        ${headerHtml}
        <tr>
          <td style="padding:8px 24px 24px 24px;font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};font-size:16px;line-height:1.7;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              ${blocksHtml}
            </table>
          </td>
        </tr>
        ${userFooterHtml}
        ${eiaawFooter}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  }

  function renderBlockHtml(b, brand) {
    const safeFont = brand.font;
    switch (b.type) {
      case 'h1':
        return `<tr><td align="${b.align || 'left'}" style="padding:8px 0;font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};font-size:30px;line-height:1.25;font-weight:800;letter-spacing:-0.02em;">${esc(b.text)}</td></tr>`;
      case 'h2':
        return `<tr><td align="${b.align || 'left'}" style="padding:6px 0;font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;">${esc(b.text)}</td></tr>`;
      case 'h3':
        return `<tr><td align="${b.align || 'left'}" style="padding:6px 0;font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};font-size:18px;line-height:1.35;font-weight:700;">${esc(b.text)}</td></tr>`;
      case 'p': {
        const paragraphs = String(b.text || '').split(/\n\s*\n/).map(p =>
          `<p style="margin:0 0 14px 0;">${esc(p).replace(/\n/g, '<br>')}</p>`
        ).join('');
        return `<tr><td align="${b.align || 'left'}" style="padding:6px 0;font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};font-size:16px;line-height:1.7;">${paragraphs}</td></tr>`;
      }
      case 'image':
        if (!b.url) return '';
        return `<tr><td align="center" style="padding:14px 0;"><img src="${escAttr(b.url)}" alt="${escAttr(b.alt || '')}" style="max-width:100%;height:auto;border-radius:10px;display:block;border:0;outline:none;"></td></tr>`;
      case 'cta': {
        const sz = BTN_SIZES[b.size] || BTN_SIZES.md;
        const url = (b.url || '').trim() || 'https://example.com';
        return `<tr><td align="${b.align || 'center'}" style="padding:18px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center" bgcolor="${escAttr(b.bg)}" style="border-radius:8px;background:${escAttr(b.bg)};">
              <a href="${escAttr(url)}" style="display:inline-block;padding:${sz.padY}px ${sz.padX}px;font-family:${escAttr(b.font || safeFont)};font-size:${sz.font}px;font-weight:700;line-height:1;color:${escAttr(b.color)};text-decoration:none;border-radius:8px;">${esc(b.text)}</a>
            </td></tr>
          </table>
        </td></tr>`;
      }
      case 'divider':
        return `<tr><td style="padding:14px 0;"><div style="height:1px;background:#E8DFCC;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>`;
      case 'spacer':
        return `<tr><td style="height:${parseInt(b.height) || 24}px;line-height:${parseInt(b.height) || 24}px;font-size:1px;">&nbsp;</td></tr>`;
      case 'html':
        // Trusted: comes from our own AI endpoint. We strip <script>/<style> tags as a belt-and-braces measure.
        const clean = String(b.html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
        return `<tr><td style="padding:6px 0;font-family:${escAttr(safeFont)};color:${escAttr(brand.textColor)};font-size:16px;line-height:1.7;">${clean}</td></tr>`;
      default:
        return '';
    }
  }

  // ------------- Preview modal ----------------------------------------------
  function openPreview(d) {
    let modal = document.getElementById('ed-preview-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'ed-preview-modal';
    modal.className = 'ed-preview-overlay';
    const html = compileEmail(d || ensureDesign());
    modal.innerHTML = `
      <div class="ed-preview-shell" onclick="event.stopPropagation()">
        <div class="ed-preview-bar">
          <strong>Preview</strong>
          <div class="ed-preview-tabs">
            <button class="active" data-w="600" onclick="EmailDesigner_setPreviewWidth(this, 600)">Desktop</button>
            <button data-w="380" onclick="EmailDesigner_setPreviewWidth(this, 380)">Mobile</button>
          </div>
          <button class="ed-preview-close" onclick="EmailDesigner_closePreview()">&times;</button>
        </div>
        <div class="ed-preview-stage">
          <iframe id="ed-preview-iframe" sandbox="allow-same-origin" style="width:600px;"></iframe>
        </div>
      </div>
    `;
    modal.addEventListener('click', () => window.EmailDesigner_closePreview());
    document.body.appendChild(modal);
    const iframe = document.getElementById('ed-preview-iframe');
    iframe.srcdoc = html;
  }

  window.EmailDesigner_setPreviewWidth = function (btn, w) {
    document.querySelectorAll('.ed-preview-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const f = document.getElementById('ed-preview-iframe');
    if (f) f.style.width = w + 'px';
  };

  window.EmailDesigner_closePreview = function () {
    const m = document.getElementById('ed-preview-modal');
    if (m) m.remove();
  };
})();
