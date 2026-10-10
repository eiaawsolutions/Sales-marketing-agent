import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The SPA treats every 401 as "your session is gone" and drops the user on the
// login page. So a wrong *answer* from a signed-in user (current password, a
// TOTP code) must not be a 401, or one typo silently logs them out and the
// error message never shows.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-pwchange-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');

const { default: express } = await import('express');
const { default: authRouter } = await import('../src/routes/auth.js');
const { default: db } = await import('../src/db/index.js');
const { hashPassword, verifyPassword } = await import('../src/middleware/auth.js');

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan, email_verified)
              VALUES (1, 'owner', 'owner@customer.test', ?, 'user', 'active', 'pro', 1)`).run(hashPassword('OldPassword1'));
  for (const token of ['this-device', 'other-device']) {
    db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, 1, datetime('now', '+1 day'))").run(token);
  }
});

const post = (url, token, body) => fetch(`${base}/api/auth${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const me = (token) => fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const passwordHash = () => db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash;

test('wrong current password is a 400 and keeps the session signed in', async () => {
  const res = await post('/reset-password', 'this-device', { currentPassword: 'not-it', newPassword: 'NewPassword2' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Current password is incorrect');
  assert.equal((await me('this-device')).status, 200);
  assert.ok(verifyPassword('OldPassword1', passwordHash()), 'password unchanged');
});

test('correct current password changes it and signs out the other devices only', async () => {
  const res = await post('/reset-password', 'this-device', { currentPassword: 'OldPassword1', newPassword: 'NewPassword2' });
  assert.equal(res.status, 200);
  assert.ok(verifyPassword('NewPassword2', passwordHash()));
  assert.ok(!verifyPassword('OldPassword1', passwordHash()));

  assert.equal((await me('this-device')).status, 200, 'the device that changed it stays signed in');
  const other = await me('other-device');
  assert.equal(other.status, 401);
  const body = await other.json();
  assert.equal(body.code, 'session_displaced');
  assert.match(body.error, /password was changed/i);
});

test('mistyped code while confirming 2FA setup is a 400, not a sign-out', async () => {
  db.prepare("UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_enabled = 0 WHERE id = 1").run();
  const res = await post('/mfa/verify-setup', 'this-device', { code: 'not-a-code' });
  assert.equal(res.status, 400);
  assert.equal((await me('this-device')).status, 200);
});

test('mistyped code while disabling 2FA is a 400, not a sign-out', async () => {
  db.prepare("UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_enabled = 1 WHERE id = 1").run();
  const res = await post('/mfa/disable', 'this-device', { code: 'not-a-code' });
  assert.equal(res.status, 400);
  assert.equal((await me('this-device')).status, 200);
});
