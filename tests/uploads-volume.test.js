import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// An uploaded logo or image lives on the data volume, beside the database.
// Uploads used to be written into public/media inside the container, which
// every deploy replaces: on 28 Oct 2026 a campaign's logo was gone minutes
// after it was uploaded, and every lead who opened the email saw a broken image.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-uploads-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: db } = await import('../src/db/index.js');
const { default: uploadsRouter, uploadsStatic } = await import('../src/routes/uploads.js');
const publicMedia = new URL('../public/media/', import.meta.url);

const app = express();
app.use((req, res, next) => { req.user = { id: 2 }; next(); });
app.use('/api/uploads', uploadsRouter);
app.use('/media', uploadsStatic);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

// A 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('an uploaded image is stored on the data volume, not inside the app', async () => {
  const r = await fetch(`${base}/api/uploads/logo`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${PNG}`, filename: 'EIAAW logo stacked.png' }),
  });
  assert.equal(r.status, 200);
  const { url, path: rel } = await r.json();
  const name = rel.replace('/media/', '');
  assert.match(name, /^u2-\d+-[0-9a-f]{8}-eiaaw-logo-stacked-png\.png$/);
  assert.ok(url.endsWith(`/media/${name}`));
  assert.ok(existsSync(path.join(dir, 'media', name)), 'saved beside the database');
  assert.equal(existsSync(new URL(name, publicMedia)), false, 'not written into public/media');

  const img = await fetch(`${base}/media/${name}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), readFileSync(path.join(dir, 'media', name)));
});

test('a name that is not an upload falls through to the bundled site images', async () => {
  const r = await fetch(`${base}/media/hero.jpg`);
  assert.equal(r.status, 404, 'not served from the uploads folder; public/ serves it in the app');
});
