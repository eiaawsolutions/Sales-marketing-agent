import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// An email campaign keeps the designer's blocks beside the HTML they compile
// to. It used to keep the HTML only, so Edit could not reopen the layout and
// started from the designer's "Welcome" starter instead.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-design-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { campaignsService } = await import('../src/services/campaigns.js');

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['campaign_leads', 'campaigns', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (2, 'amos', 'amos@example.com', 'x', 'user', 'active', 'business')").run();
});

const DESIGN = JSON.stringify({ mode: 'scratch', brand: {}, header: {}, footer: {}, blocks: [{ type: 'h1', text: 'AI that does the work.' }] });

test('the design is saved with a new campaign and comes back on Edit', () => {
  const c = campaignsService.create(2, { name: 'Brief', type: 'email', subject: 'Hi', body: '<p>x</p>', design: DESIGN });
  assert.equal(campaignsService.getById(2, c.id).design, DESIGN);
});

test('an edit that sends no design keeps the saved one; an edit that sends one replaces it', () => {
  const c = campaignsService.create(2, { name: 'Brief', type: 'email', subject: 'Hi', body: '<p>x</p>', design: DESIGN });
  campaignsService.update(2, c.id, { subject: 'New subject' });
  assert.equal(campaignsService.getById(2, c.id).design, DESIGN);
  const next = JSON.stringify({ blocks: [{ type: 'p', text: 'Shorter.' }] });
  campaignsService.update(2, c.id, { design: next });
  assert.equal(campaignsService.getById(2, c.id).design, next);
});

test('a design that is not the designer\'s JSON, or is too large, is refused', () => {
  assert.throws(() => campaignsService.create(2, { name: 'A', type: 'email', design: 'not json' }), /design/i);
  assert.throws(() => campaignsService.create(2, { name: 'A', type: 'email', design: '{"no":"blocks"}' }), /design/i);
  const huge = JSON.stringify({ blocks: [{ type: 'p', text: 'x'.repeat(300_000) }] });
  const c = campaignsService.create(2, { name: 'A', type: 'email', body: '<p>x</p>' });
  assert.throws(() => campaignsService.update(2, c.id, { design: huge }), /design/i);
  assert.equal(campaignsService.getById(2, c.id).design, null);
});

// The wizard (public/app.js): what Edit loads, and what Save sends.
function wizard(designer) {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const ctx = { window: { EmailDesigner: designer } };
  vm.createContext(ctx);
  for (const name of ['loadSavedDesign', 'wizardPayload']) {
    vm.runInContext(src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))[0], ctx);
  }
  return ctx;
}

test('Edit opens the saved design; without one it reads the design back out of the saved email', () => {
  const recovered = { blocks: [{ type: 'p', text: 'from html' }] };
  const w = wizard({ fromHtml: (html) => (html.includes('ed-card') ? recovered : null) });
  assert.equal(JSON.stringify(w.loadSavedDesign({ type: 'email', design: DESIGN, body: '<table class="ed-card"></table>' })), DESIGN);
  assert.equal(w.loadSavedDesign({ type: 'email', design: null, body: '<table class="ed-card"></table>' }), recovered);
  assert.equal(w.loadSavedDesign({ type: 'email', design: null, body: '<p>AI wrote this</p>' }), null);
  assert.equal(w.loadSavedDesign({ type: 'social', design: null, body: '<table class="ed-card"></table>' }), null);
  assert.equal(w.loadSavedDesign({ type: 'email', design: '{broken', body: '<p>AI wrote this</p>' }), null);
});

test('Save sends the design with an email campaign, and none for a campaign the designer did not make', () => {
  const w = wizard({});
  const d = { name: 'Brief', type: 'email', subject: 'Hi', body: '<p>x</p>', target_audience: '', budget_limit: 0, form_id: null };
  assert.equal(w.wizardPayload({ ...d, design: JSON.parse(DESIGN) }).design, DESIGN);
  assert.equal('design' in w.wizardPayload({ ...d, design: null }), false);
  assert.equal('design' in w.wizardPayload({ ...d, type: 'social', design: JSON.parse(DESIGN) }), false);
});
