import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-aikey-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
process.env.ENCRYPTION_KEY = 'test-encryption-key';
delete process.env.ANTHROPIC_API_KEY;

const { default: db } = await import('../src/db/index.js');
const { encrypt } = await import('../src/utils/crypto.js');
const { resolveAnthropicKey } = await import('../src/config/ai-key.js');
const { __testing: agent } = await import('../src/services/ai-agent.js');

const realEncryptionKey = process.env.ENCRYPTION_KEY;
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function saveSettingsKey(value) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
}
beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE key = 'api_key'").run();
  process.env.ENCRYPTION_KEY = realEncryptionKey;
  delete process.env.ANTHROPIC_API_KEY;
});

test('a key saved on the Settings page wins, so changing it there works without a redeploy', () => {
  saveSettingsKey(encrypt('sk-ant-new-key'));
  assert.deepEqual(resolveAnthropicKey({ ANTHROPIC_API_KEY: 'sk-ant-revoked-infisical-key' }), { key: 'sk-ant-new-key', source: 'settings' });
});

test('the Infisical key is used when nothing is saved on the Settings page', () => {
  assert.deepEqual(resolveAnthropicKey({ ANTHROPIC_API_KEY: 'sk-ant-infisical-key' }), { key: 'sk-ant-infisical-key', source: 'env' });
});

test('a Settings key that no longer decrypts is never sent as the key', () => {
  saveSettingsKey(encrypt('sk-ant-saved-under-old-encryption-key'));
  process.env.ENCRYPTION_KEY = 'a-different-encryption-key';
  assert.deepEqual(resolveAnthropicKey({}), { key: '', source: null });
  assert.equal(resolveAnthropicKey({ ANTHROPIC_API_KEY: 'sk-ant-current-key' }).key, 'sk-ant-current-key');
});

test('an unresolved secret:// handle is never sent as the key', () => {
  const env = { ANTHROPIC_API_KEY: 'secret://eiaaw-all-projects/prod/SALES_AGENT_ANTHROPIC_API_KEY' };
  assert.deepEqual(resolveAnthropicKey(env), { key: '', source: null });
});

test('stray whitespace around a key is dropped', () => {
  assert.equal(resolveAnthropicKey({ ANTHROPIC_API_KEY: '  sk-ant-current-key\n' }).key, 'sk-ant-current-key');
  saveSettingsKey(encrypt(' sk-ant-local-dev-key '));
  assert.equal(resolveAnthropicKey({}).key, 'sk-ant-local-dev-key');
});

test('with no key anywhere there is nothing to send', () => {
  assert.deepEqual(resolveAnthropicKey({ ANTHROPIC_API_KEY: '   ' }), { key: '', source: null });
});

test('the agent calls Claude with the key saved on the Settings page', () => {
  saveSettingsKey(encrypt('sk-ant-new-key'));
  process.env.ANTHROPIC_API_KEY = 'sk-ant-revoked-infisical-key';
  assert.equal(agent.getClient().apiKey, 'sk-ant-new-key');
});

test('with no usable key the agent says so instead of calling Claude', () => {
  saveSettingsKey('enc:not-decryptable');
  assert.throws(() => agent.getClient(), /API key not configured/);
});

test('a rejected API key reads as a platform problem, not "invalid x-api-key"', () => {
  const err = Object.assign(
    new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}'),
    { status: 401 },
  );
  const msg = agent.cleanAIError(err);
  assert.notEqual(msg, 'invalid x-api-key');
  assert.match(msg, /AI service/);
  assert.match(msg, /not your Brief/);
});

test('other AI errors still come through as Anthropic worded them', () => {
  const err = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}');
  assert.equal(agent.cleanAIError(err), 'max_tokens: too large');
});
