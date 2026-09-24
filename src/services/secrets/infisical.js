/**
 * Infisical resolver: turns `secret://<workspace>/<env>[/<path>]/<NAME>` handles
 * in process.env into real values before the app loads (EIAAW Deploy Contract).
 *
 * - Off unless INFISICAL_RESOLVER_ENABLED=true; handles are left as-is.
 * - Universal-auth login with the app's machine identity, then one
 *   GET /api/v4/secrets/{name} per handle, scoped to INFISICAL_PROJECT_ID.
 *   The handle's workspace segment is documentation; the project ID decides.
 * - Fails closed: bad bootstrap creds, a failed login, a missing required
 *   secret or a handle outside the allow-list throw, so the process never
 *   starts with a literal "secret://..." where a key should be.
 * - Logs key names only, never values.
 *
 * Plain fetch, no SDK: one fewer dependency on the boot path.
 */
import { REQUIRED_ENV_KEYS, OPTIONAL_ENV_KEYS } from '../../config/secrets.js';

const HANDLE_PREFIX = 'secret://';
const DEFAULT_SITE_URL = 'https://app.infisical.com';
const DEFAULT_TIMEOUT_MS = 5000;

export function parseHandle(value) {
  if (typeof value !== 'string' || !value.startsWith(HANDLE_PREFIX)) return null;
  const parts = value.slice(HANDLE_PREFIX.length).split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const [workspace, environment, ...rest] = parts;
  const secretName = rest.pop();
  return { workspace, environment, secretPath: rest.length ? `/${rest.join('/')}` : '/', secretName };
}

export async function resolveEnv({ env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  const report = { enabled: env.INFISICAL_RESOLVER_ENABLED === 'true', resolved: [], skippedOptional: [] };
  const handles = Object.entries(env)
    .map(([key, value]) => ({ key, handle: parseHandle(value) }))
    .filter(({ handle }) => handle);

  if (!report.enabled) {
    // A handle left unresolved would be used as the secret itself (e.g. as
    // the encryption key), so refuse in production and warn elsewhere.
    if (handles.length) {
      const keys = handles.map(({ key }) => key).join(', ');
      const msg = `[infisical] ${keys} hold secret:// handles but INFISICAL_RESOLVER_ENABLED is not "true"`;
      if (env.NODE_ENV === 'production') throw new Error(msg);
      log.warn(`${msg}; they will be used as literal strings`);
    }
    return report;
  }

  if (handles.length === 0) {
    log.warn('[infisical] resolver enabled but no secret:// handles found in env');
    return report;
  }

  const known = new Set([...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS]);
  const unknown = handles.filter(({ key }) => !known.has(key)).map(({ key }) => key);
  if (unknown.length) {
    throw new Error(`[infisical] secret:// handle set for ${unknown.join(', ')}, which is not in src/config/secrets.js`);
  }

  const client = await login(env, fetchImpl);
  const optional = new Set(OPTIONAL_ENV_KEYS);
  const failed = [];

  for (const { key, handle } of handles) {
    try {
      env[key] = await client.getSecret(handle);
      report.resolved.push(key);
    } catch (err) {
      if (err.status === 404 && optional.has(key)) {
        delete env[key];
        report.skippedOptional.push(key);
        log.warn(`[infisical] optional ${key} not found in Infisical; continuing without it`);
      } else {
        failed.push(`${key} (${err.message})`);
      }
    }
  }

  if (failed.length) throw new Error(`[infisical] could not resolve ${failed.length} secret(s): ${failed.join('; ')}`);
  log.info(`[infisical] resolved ${report.resolved.length} secret(s): ${report.resolved.join(', ')}`);
  return report;
}

async function login(env, fetchImpl) {
  const clientId = env.INFISICAL_APP_CLIENT_ID;
  const clientSecret = env.INFISICAL_APP_CLIENT_SECRET;
  const projectId = env.INFISICAL_PROJECT_ID;
  if (!clientId || !clientSecret || !projectId) {
    throw new Error('[infisical] resolver enabled but INFISICAL_APP_CLIENT_ID, INFISICAL_APP_CLIENT_SECRET and INFISICAL_PROJECT_ID are not all set');
  }
  const siteUrl = (env.INFISICAL_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(env.INFISICAL_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const request = (path, init = {}) => fetchImpl(`${siteUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  const res = await request('/api/v1/auth/universal-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) throw new Error(`[infisical] universal-auth login failed (HTTP ${res.status})`);
  const { accessToken } = await res.json();
  if (!accessToken) throw new Error('[infisical] universal-auth login returned no access token');

  return {
    async getSecret({ environment, secretPath, secretName }) {
      const query = new URLSearchParams({ projectId, environment, secretPath });
      const r = await request(`/api/v4/secrets/${encodeURIComponent(secretName)}?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status} for ${secretName} at ${environment}${secretPath}`);
        err.status = r.status;
        throw err;
      }
      const value = (await r.json())?.secret?.secretValue;
      if (typeof value !== 'string') throw new Error(`no value returned for ${secretName}`);
      return value;
    },
  };
}
