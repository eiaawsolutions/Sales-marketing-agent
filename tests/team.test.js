import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// Seats: the account owner invites teammates up to the plan's seat count.
// A teammate works in the owner's account (leads, campaigns, approvals) with
// their own login, but never touches billing, the owner's credentials or
// another account.
const dir = mkdtempSync(path.join(tmpdir(), 'sa-team-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const { requireAuth, actAsAccount } = await import('../src/middleware/auth.js');
const { default: teamRouter } = await import('../src/routes/team.js');
const { default: leadsRouter } = await import('../src/routes/leads.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { default: billingRouter } = await import('../src/routes/billing.js');
const { deleteAccountData } = await import('../src/services/retention.js');

const realFetch = globalThis.fetch;
let mails = [];
after(() => { globalThis.fetch = realFetch; db.close(); rmSync(dir, { recursive: true, force: true }); });

function session(userId) {
  const token = `sess-${userId}-${Math.random().toString(16).slice(2)}`;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(token, userId);
  return token;
}

function reset(plan = 'business') {
  for (const t of ['sessions', 'activities', 'leads', 'account_profiles']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM users WHERE account_owner_id IS NOT NULL').run();
  db.prepare('DELETE FROM users').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'reset_token_%'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('resend_api_key', 're_test_key_123')").run();
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan, display_name, email_verified) VALUES (2, 'aaron', 'aaron@tll.example', 'x', 'user', 'active', ?, 'Aaron Joseph', 1)`).run(plan);
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan, email_verified) VALUES (3, 'other', 'other@example.com', 'x', 'user', 'active', 'business', 1)`).run();
  db.prepare("INSERT INTO account_profiles (user_id, business_name, offer) VALUES (2, 'The Leadership Lab', 'Leadership programmes')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email) VALUES (20, 2, 'Lee Shu Fen', 'shufen@velora.example')").run();
  db.prepare("INSERT INTO leads (id, user_id, name, email) VALUES (30, 3, 'Not Yours', 'n@other.example')").run();
  mails = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      mails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `re_${mails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
}
beforeEach(() => reset());

async function api(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/team', requireAuth, teamRouter);
  app.use('/api/leads', requireAuth, actAsAccount, leadsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  const s = app.listen(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (token, method, p, body) => {
    const r = await realFetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, body: json };
  };
  try { await fn(call); } finally { s.close(); }
}

async function invite(call, ownerToken, email, name = 'Shaun') {
  return call(ownerToken, 'POST', '/api/team/invite', { email, name });
}

test('the owner invites a teammate, who gets a set-password link and works in the same account', async () => {
  const owner = session(2);
  await api(async (call) => {
    const r = await invite(call, owner, 'shaun@tll.example');
    assert.equal(r.status, 200);
    const team = await call(owner, 'GET', '/api/team');
    assert.equal(team.body.seats_used, 2);
    assert.equal(team.body.seats_limit, 10);
    assert.deepEqual(team.body.members.map(m => m.email), ['shaun@tll.example']);
  });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to[0], 'shaun@tll.example');
  assert.match(mails[0].html, /The Leadership Lab/);
  assert.match(mails[0].html, /\/app\?reset=[0-9a-f]{64}/);

  const member = db.prepare("SELECT id, account_owner_id, plan FROM users WHERE email = 'shaun@tll.example'").get();
  assert.equal(member.account_owner_id, 2);
  const mt = session(member.id);
  await api(async (call) => {
    const leads = await call(mt, 'GET', '/api/leads');
    assert.deepEqual(leads.body.map(l => l.id), [20], "the teammate sees the owner's leads and nobody else's");
    const created = await call(mt, 'POST', '/api/leads', { name: 'New One', email: 'new@x.example' });
    assert.equal(created.status, 201);
    const me = await call(mt, 'GET', '/api/auth/me');
    assert.equal(me.body.email, 'shaun@tll.example', 'personal routes stay personal');
  });
  assert.equal(db.prepare("SELECT user_id FROM leads WHERE email = 'new@x.example'").get().user_id, 2, 'work is stored in the account');
});

test("the plan's seat count is enforced (Pro: 3 seats including the owner)", async () => {
  reset('pro');
  const owner = session(2);
  await api(async (call) => {
    assert.equal((await invite(call, owner, 'a@tll.example')).status, 200);
    assert.equal((await invite(call, owner, 'b@tll.example')).status, 200);
    const third = await invite(call, owner, 'c@tll.example');
    assert.equal(third.status, 403);
    assert.match(third.body.error, /3 seats/);
  });
});

test('a teammate cannot invite, remove anyone or touch billing', async () => {
  const owner = session(2);
  await api(async (call) => { await invite(call, owner, 'shaun@tll.example'); });
  const mt = session(db.prepare("SELECT id FROM users WHERE email = 'shaun@tll.example'").get().id);
  await api(async (call) => {
    assert.equal((await invite(call, mt, 'x@tll.example')).status, 403);
    assert.equal((await call(mt, 'DELETE', '/api/team/2')).status, 403);
    assert.equal((await call(mt, 'POST', '/api/billing/portal', {})).status, 403);
    assert.equal((await call(mt, 'POST', '/api/billing/upgrade', { plan: 'pro' })).status, 403);
  });
});

test('an email already in use cannot be invited, and invites never reveal whose it is', async () => {
  const owner = session(2);
  await api(async (call) => {
    const r = await invite(call, owner, 'other@example.com');
    assert.equal(r.status, 409);
    assert.doesNotMatch(JSON.stringify(r.body), /other/);
  });
});

test('removing a teammate signs them out; another owner cannot remove them', async () => {
  const owner = session(2);
  await api(async (call) => { await invite(call, owner, 'shaun@tll.example'); });
  const memberId = db.prepare("SELECT id FROM users WHERE email = 'shaun@tll.example'").get().id;
  const mt = session(memberId);
  await api(async (call) => {
    assert.equal((await call(session(3), 'DELETE', `/api/team/${memberId}`)).status, 404);
    assert.equal((await call(owner, 'DELETE', `/api/team/${memberId}`)).status, 200);
    assert.equal((await call(mt, 'GET', '/api/leads')).status, 401);
  });
});

test("when the owner's account is suspended, teammates are locked out too", async () => {
  const owner = session(2);
  await api(async (call) => { await invite(call, owner, 'shaun@tll.example'); });
  const mt = session(db.prepare("SELECT id FROM users WHERE email = 'shaun@tll.example'").get().id);
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = 2").run();
  await api(async (call) => {
    assert.equal((await call(mt, 'GET', '/api/leads')).status, 403);
  });
});

test("deleting the owner's account deletes the teammates' logins with it", async () => {
  const owner = session(2);
  await api(async (call) => { await invite(call, owner, 'shaun@tll.example'); });
  deleteAccountData(db, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email = 'shaun@tll.example'").get().c, 0);
});
