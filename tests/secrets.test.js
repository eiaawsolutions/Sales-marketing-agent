import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandle, resolveEnv } from '../src/services/secrets/infisical.js';
import { REQUIRED_ENV_KEYS, OPTIONAL_ENV_KEYS } from '../src/config/secrets.js';

const BOOT = {
  INFISICAL_RESOLVER_ENABLED: 'true',
  INFISICAL_APP_CLIENT_ID: 'cid',
  INFISICAL_APP_CLIENT_SECRET: 'csecret',
  INFISICAL_PROJECT_ID: 'proj-123',
};

/** Fake Infisical: records calls, serves `store` by secret name. */
function fakeInfisical(store, { loginStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), init });
    if (u.pathname === '/api/v1/auth/universal-auth/login') {
      return { ok: loginStatus === 200, status: loginStatus, json: async () => ({ accessToken: 'tok', expiresIn: 3600, tokenType: 'Bearer' }) };
    }
    const name = decodeURIComponent(u.pathname.split('/').pop());
    if (!(name in store)) return { ok: false, status: 404, json: async () => ({ message: 'Secret not found' }) };
    return { ok: true, status: 200, json: async () => ({ secret: { secretKey: name, secretValue: store[name] } }) };
  };
  return { fetchImpl, calls };
}

const quietLog = { info() {}, warn() {} };

test('parses flat house-layout and foldered handles', () => {
  assert.deepEqual(parseHandle('secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY'),
    { workspace: 'eiaaw-all-projects', environment: 'prod', secretPath: '/', secretName: 'ANTHROPIC_API_KEY' });
  assert.deepEqual(parseHandle('secret://ws/prod/llm/keys/ANTHROPIC_API_KEY'),
    { workspace: 'ws', environment: 'prod', secretPath: '/llm/keys', secretName: 'ANTHROPIC_API_KEY' });
  assert.equal(parseHandle('sk-ant-raw-value'), null);
  assert.equal(parseHandle('secret://too/short'), null);
});

test('disabled resolver is a no-op and makes no network calls', async () => {
  const env = { ANTHROPIC_API_KEY: 'secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY' };
  const { fetchImpl, calls } = fakeInfisical({});
  const report = await resolveEnv({ env, fetchImpl, log: quietLog });
  assert.equal(report.enabled, false);
  assert.equal(calls.length, 0);
  assert.equal(env.ANTHROPIC_API_KEY, 'secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY');
});

test('resolver off with a handle present: fatal in production, warning elsewhere', async () => {
  const handle = 'secret://eiaaw-all-projects/prod/SALES_AGENT_ENCRYPTION_KEY';
  await assert.rejects(
    resolveEnv({ env: { NODE_ENV: 'production', ENCRYPTION_KEY: handle }, fetchImpl: fakeInfisical({}).fetchImpl, log: quietLog }),
    /ENCRYPTION_KEY.*INFISICAL_RESOLVER_ENABLED/,
  );
  const warnings = [];
  const env = { NODE_ENV: 'development', ENCRYPTION_KEY: handle };
  await resolveEnv({ env, fetchImpl: fakeInfisical({}).fetchImpl, log: { info() {}, warn: (m) => warnings.push(m) } });
  assert.match(warnings.join('\n'), /ENCRYPTION_KEY/);
});

test('resolves handles in place with one login, via the v4 API scoped to the project', async () => {
  const env = {
    ...BOOT,
    ANTHROPIC_API_KEY: 'secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY',
    ENCRYPTION_KEY: 'secret://eiaaw-all-projects/prod/SALES_AGENT_ENCRYPTION_KEY',
    SMTP_HOST: 'smtp.example.com',
  };
  const { fetchImpl, calls } = fakeInfisical({ ANTHROPIC_API_KEY: 'sk-real', SALES_AGENT_ENCRYPTION_KEY: 'enc-real' });
  const report = await resolveEnv({ env, fetchImpl, log: quietLog });

  assert.equal(env.ANTHROPIC_API_KEY, 'sk-real');
  assert.equal(env.ENCRYPTION_KEY, 'enc-real');
  assert.equal(env.SMTP_HOST, 'smtp.example.com', 'non-handle values are untouched');
  assert.deepEqual(report.resolved.sort(), ['ANTHROPIC_API_KEY', 'ENCRYPTION_KEY']);

  assert.equal(calls.filter((c) => c.path.endsWith('/login')).length, 1, 'one login for all keys');
  const get = calls.find((c) => c.path === '/api/v4/secrets/SALES_AGENT_ENCRYPTION_KEY');
  assert.ok(get, 'reads the secret named in the handle, not the env var name');
  assert.equal(get.query.projectId, 'proj-123');
  assert.equal(get.query.environment, 'prod');
  assert.equal(get.query.secretPath, '/');
  assert.equal(get.init.headers.Authorization, 'Bearer tok');
});

test('fails closed when enabled without bootstrap credentials', async () => {
  const env = { INFISICAL_RESOLVER_ENABLED: 'true', ANTHROPIC_API_KEY: 'secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY' };
  await assert.rejects(resolveEnv({ env, fetchImpl: fakeInfisical({}).fetchImpl, log: quietLog }), /INFISICAL_APP_CLIENT_ID/);
});

test('a missing required secret fails the boot and names the key but never a value', async () => {
  const env = { ...BOOT, ANTHROPIC_API_KEY: 'secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY', ENCRYPTION_KEY: 'secret://eiaaw-all-projects/prod/SALES_AGENT_ENCRYPTION_KEY' };
  const { fetchImpl } = fakeInfisical({ ANTHROPIC_API_KEY: 'sk-real' });
  await assert.rejects(resolveEnv({ env, fetchImpl, log: quietLog }), (err) => {
    assert.match(err.message, /ENCRYPTION_KEY/);
    assert.doesNotMatch(err.message, /sk-real/);
    return true;
  });
});

test('a missing optional secret is dropped with a warning, not left as a handle', async () => {
  const warnings = [];
  const env = { ...BOOT, APOLLO_API_KEY: 'secret://eiaaw-all-projects/prod/APOLLO_API_KEY' };
  const report = await resolveEnv({ env, fetchImpl: fakeInfisical({}).fetchImpl, log: { info() {}, warn: (m) => warnings.push(m) } });
  assert.equal('APOLLO_API_KEY' in env, false);
  assert.deepEqual(report.skippedOptional, ['APOLLO_API_KEY']);
  assert.match(warnings.join('\n'), /APOLLO_API_KEY/);
});

test('a login failure is fatal even when only optional keys are handles', async () => {
  const env = { ...BOOT, APOLLO_API_KEY: 'secret://eiaaw-all-projects/prod/APOLLO_API_KEY' };
  await assert.rejects(resolveEnv({ env, fetchImpl: fakeInfisical({}, { loginStatus: 401 }).fetchImpl, log: quietLog }), /login failed \(HTTP 401\)/);
});

test('an unresolved handle for a key outside the allow-list fails the boot', async () => {
  const env = { ...BOOT, SOME_NEW_KEY: 'secret://eiaaw-all-projects/prod/SOME_NEW_KEY' };
  await assert.rejects(resolveEnv({ env, fetchImpl: fakeInfisical({ SOME_NEW_KEY: 'x' }).fetchImpl, log: quietLog }), /SOME_NEW_KEY.*not in src\/config\/secrets\.js/);
});

test('logs name the resolved keys and never their values', async () => {
  const lines = [];
  const env = { ...BOOT, VOICE_REFRESH_TOKEN: 'secret://eiaaw-all-projects/prod/SALES_AGENT_VOICE_REFRESH_TOKEN' };
  await resolveEnv({ env, fetchImpl: fakeInfisical({ SALES_AGENT_VOICE_REFRESH_TOKEN: 'super-secret-token' }).fetchImpl, log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) } });
  assert.match(lines.join('\n'), /VOICE_REFRESH_TOKEN/);
  assert.doesNotMatch(lines.join('\n'), /super-secret-token/);
});

test('allow-list covers every secret the app reads, and bootstrap creds are never resolvable', () => {
  const all = [...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS];
  for (const key of ['ANTHROPIC_API_KEY', 'ENCRYPTION_KEY', 'STRIPE_WEBHOOK_SECRET', 'VOICE_REFRESH_TOKEN', 'RESEND_API_KEY', 'SMTP_PASS']) {
    assert.ok(all.includes(key), `${key} missing from src/config/secrets.js`);
  }
  assert.equal(all.some((k) => k.startsWith('INFISICAL_')), false);
  assert.equal(new Set(all).size, all.length, 'no duplicates');
});
