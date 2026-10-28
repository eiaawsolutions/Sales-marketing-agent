// Anthropic API key — the single place the key is chosen.
//
// ANTHROPIC_API_KEY in env (resolved from Infisical at boot, and a REQUIRED
// key in config/secrets.js) is the system of record. A key saved on the
// Settings page used to win over it, so an old key left in the settings table
// kept being sent after the real one changed, and lead search, scoring and the
// chatbot all failed with Anthropic's "invalid x-api-key" (28 Oct 2026). The
// Settings key is now only a fallback for when the server has no key of its
// own (local dev).
//
// A value that is not a usable key is skipped, never sent: a settings value
// that would not decrypt (decrypt() hands back the "enc:..." ciphertext when
// ENCRYPTION_KEY has changed) or an env value still holding a secret:// handle.

import db from '../db/index.js';
import { decrypt } from '../utils/crypto.js';

function usable(value) {
  const v = (value || '').trim();
  if (!v || v.startsWith('enc:') || v.startsWith('secret://')) return '';
  return v;
}

/** @returns {{ key: string, source: 'env' | 'settings' | null }} */
export function resolveAnthropicKey(env = process.env) {
  const fromEnv = usable(env.ANTHROPIC_API_KEY);
  if (fromEnv) return { key: fromEnv, source: 'env' };

  const row = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  const fromSettings = usable(row?.value ? decrypt(row.value) : '');
  if (fromSettings) return { key: fromSettings, source: 'settings' };

  return { key: '', source: null };
}
