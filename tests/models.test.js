import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-models-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const models = await import('../src/config/models.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test('a retired model id resolves to the default instead of failing every AI call', () => {
  assert.equal(models.resolveModel('claude-sonnet-4-20250514'), models.DEFAULT_MODEL);
  assert.equal(models.resolveModel('claude-opus-4-20250514'), models.DEFAULT_MODEL);
  assert.equal(models.resolveModel('claude-3-5-sonnet-20241022'), models.DEFAULT_MODEL);
});

test('an empty or missing setting resolves to the default', () => {
  assert.equal(models.resolveModel(''), models.DEFAULT_MODEL);
  assert.equal(models.resolveModel(undefined), models.DEFAULT_MODEL);
  assert.equal(models.resolveModel('   '), models.DEFAULT_MODEL);
});

test('a current model id passes through unchanged', () => {
  assert.equal(models.resolveModel('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(models.resolveModel('claude-haiku-4-5'), 'claude-haiku-4-5');
});

test('a deprecated model keeps working until its sunset date, then falls back', () => {
  const before = new Date('2026-11-29T23:00:00Z');
  const on = new Date('2026-11-30T00:00:00Z');
  assert.equal(models.resolveModel('claude-sonnet-4-5-20250929', before), 'claude-sonnet-4-5-20250929');
  assert.equal(models.resolveModel('claude-sonnet-4-5-20250929', on), models.DEFAULT_MODEL);
});

test('the default model is not itself retired', () => {
  assert.ok(!models.isRetired(models.DEFAULT_MODEL));
  for (const m of models.SELECTABLE_MODELS) assert.ok(!models.isRetired(m.id), `${m.id} is offered in Settings but retired`);
});

test('settings validation refuses retired and malformed model ids', () => {
  assert.equal(models.isAcceptableModelId('claude-sonnet-4-6'), true);
  assert.equal(models.isAcceptableModelId('claude-sonnet-4-20250514'), false);
  assert.equal(models.isAcceptableModelId('gpt-4.1'), false);
  assert.equal(models.isAcceptableModelId('claude-x"; DROP'), false);
});

test('the agent reads ai_model through the resolver', () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_model', 'claude-sonnet-4-20250514')").run();
  assert.equal(agent.getModel(), models.DEFAULT_MODEL);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_model', 'claude-haiku-4-5')").run();
  assert.equal(agent.getModel(), 'claude-haiku-4-5');
});
