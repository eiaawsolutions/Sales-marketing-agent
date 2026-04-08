import { Router } from 'express';
import db from '../db/index.js';
import { requireSuperadmin } from '../middleware/auth.js';

const router = Router();

// All settings routes require superadmin
router.use(requireSuperadmin);

// GET /api/settings — get all settings (masks API key)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value, updated_at FROM settings').all();
  const settings = {};
  for (const row of rows) {
    // Mask sensitive values for display
    if (row.key === 'api_key' && row.value) {
      settings[row.key] = row.value.length > 12
        ? row.value.substring(0, 8) + '...' + row.value.substring(row.value.length - 4)
        : row.value ? '••••••••' : '';
    } else if (row.key === 'smtp_pass' && row.value) {
      settings[row.key] = row.value ? '••••••••' : '';
    } else if (row.key === 'admin_password' && row.value) {
      settings[row.key] = row.value ? '••••••••' : '';
    } else {
      settings[row.key] = row.value;
    }
  }
  // Also return whether keys are actually set (for status indicators)
  const apiKeyRow = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  settings._api_key_set = !!(apiKeyRow && apiKeyRow.value);
  res.json(settings);
});

// PUT /api/settings — update settings
router.put('/', (req, res) => {
  const allowedKeys = ['ai_provider', 'ai_model', 'api_key', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'from_email', 'admin_password'];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP'
  );

  const updated = [];
  for (const [key, value] of Object.entries(req.body)) {
    if (!allowedKeys.includes(key)) continue;
    // Don't overwrite with masked values
    if ((key === 'api_key' || key === 'smtp_pass' || key === 'admin_password') && (value.includes('•') || value.includes('...'))) continue;
    upsert.run(key, value, value);
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

    const apiKey = apiKeyRow?.value || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ success: false, error: 'No API key configured' });

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: modelRow?.value || 'claude-sonnet-4-20250514',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Reply with exactly: CONNECTION_OK' }],
    });

    const text = response.content[0].text;
    res.json({ success: true, model: response.model, response: text });
  } catch (err) {
    const msg = err.message || String(err);
    const jsonMatch = msg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
    res.json({ success: false, error: jsonMatch ? jsonMatch[1] : msg });
  }
});

export default router;
