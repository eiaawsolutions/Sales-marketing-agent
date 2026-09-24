/**
 * Boot preload: resolves Infisical `secret://` handles into process.env before
 * any app module loads. Run as
 *
 *   node --import ./src/bootstrap/secrets.js src/server.js
 *
 * `--import` finishes this module (including the await) before src/server.js
 * starts; a plain `import` at the top of server.js would not, because sibling
 * imports keep evaluating while a top-level await is pending. A throw here
 * exits the process non-zero, so a bad deploy fails its healthcheck instead of
 * serving with unresolved keys.
 */
import 'dotenv/config';
import { resolveEnv } from '../services/secrets/infisical.js';

await resolveEnv();
