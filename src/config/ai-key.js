// Anthropic API key — the single place the key is chosen.
//
// A key saved on the Settings page wins: that is where the operator changes
// it, and it takes effect on the next call with no redeploy. ANTHROPIC_API_KEY
// in env (resolved from Infisical at boot) is used when nothing is saved there.
// On 28 Oct 2026 env briefly won instead, so a fresh key saved in Settings was
// ignored while the Infisical value was the one Anthropic was rejecting.
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

/** @returns {{ key: string, source: 'settings' | 'env' | null }} */
export function resolveAnthropicKey(env = process.env) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  const fromSettings = usable(row?.value ? decrypt(row.value) : '');
  if (fromSettings) return { key: fromSettings, source: 'settings' };

  const fromEnv = usable(env.ANTHROPIC_API_KEY);
  if (fromEnv) return { key: fromEnv, source: 'env' };

  return { key: '', source: null };
}
