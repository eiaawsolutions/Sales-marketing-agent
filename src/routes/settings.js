import { Router } from 'express';
import db from '../db/index.js';
import { requireSuperadmin } from '../middleware/auth.js';
import { encrypt, decrypt, isSensitive } from '../utils/crypto.js';

const router = Router();

// All settings routes require superadmin
router.use(requireSuperadmin);

// GET /api/settings — get all settings (masks sensitive values)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM settings').all();
  const settings = {};
  for (const row of rows) {
    // Decrypt sensitive values first
    const rawValue = isSensitive(row.key) ? decrypt(row.value) : row.value;

    // Mask sensitive values for display
    if (row.key === 'api_key' && rawValue) {
      settings[row.key] = rawValue.length > 12
        ? rawValue.substring(0, 8) + '...' + rawValue.substring(rawValue.length - 4)
        : rawValue ? '••••••••' : '';
    } else if (['smtp_pass', 'admin_password'].includes(row.key) && rawValue) {
      settings[row.key] = rawValue ? '••••••••' : '';
    } else if (row.key === 'stripe_secret_key' && rawValue) {
      settings[row.key] = rawValue.length > 12
        ? rawValue.substring(0, 8) + '...' + rawValue.substring(rawValue.length - 4)
        : rawValue ? '••••••••' : '';
    } else {
      settings[row.key] = row.value; // Non-sensitive: return as-is
    }
  }
  const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  const decryptedKey = apiKeyRow?.value ? decrypt(apiKeyRow.value) : '';
  settings._api_key_set = !!(decryptedKey && decryptedKey.length > 5);
  res.json(settings);
});

// PUT /api/settings — update settings
router.put('/', (req, res) => {
  const allowedKeys = ['ai_provider', 'ai_model', 'api_key', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'from_email', 'admin_password', 'stripe_secret_key', 'stripe_publishable_key', 'ai_credit_balance', 'voice_ai_provider', 'voice_ai_api_key', 'voice_ai_agent_id'];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP'
  );

  const updated = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (!allowedKeys.includes(key)) continue;
    // Don't overwrite with masked values
    if (['api_key', 'smtp_pass', 'admin_password', 'stripe_secret_key'].includes(key) && (value.includes('•') || value.includes('...'))) continue;
    // Encrypt sensitive values before storing
    const storeValue = isSensitive(key) ? encrypt(value) : value;
    upsert.run(key, storeValue, storeValue);
    updated.push(key);
  }

  res.json({ success: true, updated });
});

// POST /api/settings/test-ai — test the AI connection
router.post('/test-ai', async (req, res) => {
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
    const modelRow = db.prepare("SELECT value FROM settings WHERE key = 'ai_model'").get();

    // Decrypt the API key
    const apiKey = apiKeyRow?.value ? decrypt(apiKeyRow.value) : process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ success: false, error: 'No API key configured' });

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: modelRow?.value || 'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Reply with exactly: CONNECTION_OK' }],
    });

    res.json({ success: true, model: response.model, response: response.content[0].text });
  } catch (err) {
    const msg = err.message || String(err);
    const jsonMatch = msg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
    res.json({ success: false, error: jsonMatch ? jsonMatch[1] : msg });
  }
});

export default router;
