import { Router } from 'express';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from '../db/index.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, '..', '..', 'public', 'media');
const MAX_BYTES = 1_500_000; // ~1.5 MB final image cap (after base64 decode)

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// Per-route body parser — main app caps JSON at 1mb which would reject a 1mb logo
// once base64-encoded (adds ~33% overhead). Allow up to 3mb just for this route.
router.use(express.json({ limit: '3mb' }));

const ALLOWED = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

router.post('/logo', (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') {
      return res.status(400).json({ error: 'dataUrl required' });
    }

    const m = dataUrl.match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
    if (!m) return res.status(400).json({ error: 'Invalid data URL — must be base64 image' });

    const mime = m[1].toLowerCase();
    const ext = ALLOWED[mime];
    if (!ext) return res.status(400).json({ error: 'Unsupported image type. Use PNG, JPG, GIF, WEBP or SVG.' });

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: `Image too large (${(buf.length/1024).toFixed(0)}KB). Max ${(MAX_BYTES/1024).toFixed(0)}KB.` });
    }

    // Light SVG sanity — block scripts to avoid stored XSS via inline SVG on our domain
    if (ext === 'svg') {
      const text = buf.toString('utf8').toLowerCase();
      if (text.includes('<script') || text.includes('onload=') || text.includes('onerror=')) {
        return res.status(400).json({ error: 'SVG contains script content and was rejected.' });
      }
    }

    const userId = req.user?.id || 0;
    const stamp = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const safeBase = (filename || 'logo').toString().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'logo';
    const fname = `u${userId}-${stamp}-${rand}-${safeBase}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, fname), buf);

    // Absolute URL — emails need full https:// URL to load images
    const baseUrl = db.prepare("SELECT value FROM settings WHERE key = 'base_url'").get()?.value
      || 'https://sa.eiaawsolutions.com';
    const absUrl = `${baseUrl.replace(/\/+$/, '')}/media/${fname}`;

    res.json({ url: absUrl, path: `/media/${fname}`, bytes: buf.length, mime });
  } catch (err) {
    console.error('Logo upload error:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

export default router;
