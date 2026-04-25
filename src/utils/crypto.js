import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING = 'base64';
const PREFIX = 'enc:'; // Prefix to identify encrypted values

// Sensitive keys that should be encrypted at rest
export const SENSITIVE_KEYS = ['api_key', 'smtp_pass', 'stripe_secret_key', 'stripe_webhook_secret', 'voice_ai_api_key', 'resend_api_key', 'apollo_api_key'];

// Refuse to silently fall back to plaintext storage when ENCRYPTION_KEY is
// missing in production. The previous behaviour saved API keys / SMTP creds /
// Stripe secrets unencrypted into settings.value while the UI still rendered
// them as masked, so an operator had no way to know secrets were sitting in
// the clear. Dev/test still get the silent-disable path so local work doesn't
// require setting a key.
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY is required in production. Refusing to start without a key — every API key and SMTP credential would be stored as plaintext.');
    }
    return null;
  }
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypt a plaintext value using AES-256-GCM
 * Returns: "enc:base64(iv + tag + ciphertext)"
 */
export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext; // No encryption key = store plaintext (backward compatible)

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: iv (16) + tag (16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return PREFIX + packed.toString(ENCODING);
}

/**
 * Decrypt an encrypted value
 * Handles both encrypted ("enc:...") and plaintext values (backward compatible)
 */
export function decrypt(value) {
  if (!value) return value;
  if (!value.startsWith(PREFIX)) return value; // Not encrypted, return as-is

  const key = getEncryptionKey();
  if (!key) return value; // Can't decrypt without key

  try {
    const packed = Buffer.from(value.slice(PREFIX.length), ENCODING);
    const iv = packed.subarray(0, IV_LENGTH);
    const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.error('Decryption failed — returning raw value. Key may have changed.');
    return value; // Return encrypted value if decryption fails
  }
}

/**
 * Check if a settings key should be encrypted
 */
export function isSensitive(key) {
  return SENSITIVE_KEYS.includes(key);
}
