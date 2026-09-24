import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-unsub-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY; // no real email leaves a test
delete process.env.SMTP_HOST;

const { default: db } = await import('../src/db/index.js');
const unsub = await import('../src/services/unsubscribe.js');
const { injectTracking, campaignsService } = await import('../src/services/campaigns.js');
const { signTracking } = await import('../src/utils/tracking-token.js');
const { processOutreachQueue } = await import('../src/services/scheduler.js');
const { default: unsubscribeRouter } = await import('../src/routes/unsubscribe.js');

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const BASE = 'https://sa.eiaawsolutions.com';

function reset() {
  for (const t of ['email_suppressions', 'outreach_queue', 'campaign_leads', 'activities', 'leads', 'campaigns', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key IN ('resend_api_key','smtp_host','smtp_user')").run();
}
function addUser(id) {
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'pro')`)
    .run(id, `user${id}`, `owner${id}@example.com`);
}
function addLead(id, userId, email) {
  db.prepare('INSERT INTO leads (id, user_id, name, email) VALUES (?, ?, ?, ?)').run(id, userId, `Lead ${id}`, email);
}
function addCampaign(id, userId, body = '<p>Hello</p>') {
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (?, ?, ?, 'email', 'active', 'Hi', ?)")
    .run(id, userId, `Campaign ${id}`, body);
}

beforeEach(reset);

test('fills {{unsubscribe_url}} with a signed per-recipient link and sets one-click headers', () => {
  const { html, headers } = unsub.prepareOutreachEmail({ html: '<p>Hi</p><a href="{{unsubscribe_url}}">Unsubscribe</a>', baseUrl: BASE, campaignId: 7, leadId: 42 });
  const url = unsub.unsubscribeUrl(BASE, 7, 42);
  assert.match(url, /^https:\/\/sa\.eiaawsolutions\.com\/unsubscribe\/7\/42\?t=[0-9a-f]{16}$/);
  assert.ok(html.includes(`href="${url}"`));
  assert.doesNotMatch(html, /\{\{unsubscribe_url\}\}/);
  assert.equal(headers['List-Unsubscribe'], `<${url}>`);
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('appends an unsubscribe footer when the template has no placeholder', () => {
  const { html } = unsub.prepareOutreachEmail({ html: '<html><body><p>Hi</p></body></html>', baseUrl: BASE, campaignId: 7, leadId: 42 });
  const url = unsub.unsubscribeUrl(BASE, 7, 42);
  assert.ok(html.includes(url), 'every outreach email carries a working unsubscribe link');
  assert.ok(html.indexOf(url) < html.indexOf('</body>'), 'footer goes inside the body');
});

test('click tracking leaves the unsubscribe link untouched', () => {
  const { html } = unsub.prepareOutreachEmail({ html: '<a href="https://example.com/offer">Offer</a><a href="{{unsubscribe_url}}">Unsubscribe</a>', baseUrl: BASE, campaignId: 7, leadId: 42 });
  const tracked = injectTracking(html, 7, 42, BASE);
  assert.ok(tracked.includes(`href="${unsub.unsubscribeUrl(BASE, 7, 42)}"`));
  assert.match(tracked, /api\/tracking\/click\/7\/42\?t=[0-9a-f]+&url=https%3A%2F%2Fexample\.com%2Foffer/);
});

test('tokens are bound to campaign + lead and separate from click-tracking tokens', () => {
  const t = new URL(unsub.unsubscribeUrl(BASE, 7, 42)).searchParams.get('t');
  assert.ok(unsub.verifyUnsubscribeToken(7, 42, t));
  assert.ok(!unsub.verifyUnsubscribeToken(7, 43, t));
  assert.ok(!unsub.verifyUnsubscribeToken(7, 42, signTracking(7, 42)), 'a click-tracking token must not unsubscribe');
  assert.ok(!unsub.verifyUnsubscribeToken(7, 42, 'not-hex'));
});

test('suppression is per sending account, case-insensitive, and stores no plaintext email', () => {
  addUser(1); addUser(2);
  unsub.suppress({ userId: 1, email: 'Jane@Example.com', reason: 'unsubscribe' });
  assert.ok(unsub.isSuppressed(1, 'jane@example.com'));
  assert.ok(unsub.isSuppressed(1, ' JANE@EXAMPLE.COM '));
  assert.ok(!unsub.isSuppressed(2, 'jane@example.com'), "one account's opt-out does not block another account");
  const row = db.prepare('SELECT * FROM email_suppressions').get();
  assert.doesNotMatch(JSON.stringify(row), /jane/i);
  unsub.suppress({ userId: 1, email: 'jane@example.com', reason: 'unsubscribe' }); // idempotent
  assert.equal(db.prepare('SELECT COUNT(*) c FROM email_suppressions').get().c, 1);
});

test('suppressing a lead cancels its pending follow-ups in that account only', () => {
  addUser(1); addUser(2); addLead(10, 1, 'jane@example.com'); addLead(20, 2, 'jane2@example.com');
  addCampaign(1, 1); addCampaign(2, 2);
  const q = db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, scheduled_at) VALUES (?, ?, 1, 'email', '<p>Follow-up</p>', 'pending', datetime('now'))");
  q.run(1, 10); q.run(2, 20);
  unsub.suppress({ userId: 1, email: 'jane@example.com', reason: 'unsubscribe', leadId: 10 });
  assert.equal(db.prepare('SELECT status FROM outreach_queue WHERE lead_id = 10').get().status, 'skipped');
  assert.equal(db.prepare('SELECT status FROM outreach_queue WHERE lead_id = 20').get().status, 'pending');
});

async function withServer(fn) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/unsubscribe', unsubscribeRouter);
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('GET shows a confirmation page and does not unsubscribe (link scanners click links)', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1);
  await withServer(async (origin) => {
    const t = new URL(unsub.unsubscribeUrl(BASE, 1, 10)).searchParams.get('t');
    const res = await fetch(`${origin}/unsubscribe/1/10?t=${t}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<form method="post"/i);
    assert.ok(!unsub.isSuppressed(1, 'jane@example.com'));
  });
});

test('POST (button or RFC 8058 one-click) unsubscribes; bad tokens change nothing', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1);
  await withServer(async (origin) => {
    const bad = await fetch(`${origin}/unsubscribe/1/10?t=0000000000000000`, { method: 'POST' });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /jane/i, 'no recipient details on the error page');
    assert.ok(!unsub.isSuppressed(1, 'jane@example.com'));

    const t = new URL(unsub.unsubscribeUrl(BASE, 1, 10)).searchParams.get('t');
    const ok = await fetch(`${origin}/unsubscribe/1/10?t=${t}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(ok.status, 200);
    assert.ok(unsub.isSuppressed(1, 'jane@example.com'));
    const again = await fetch(`${origin}/unsubscribe/1/10?t=${t}`, { method: 'POST' });
    assert.equal(again.status, 200, 'repeat unsubscribes are harmless');
  });
});

test('campaign sends skip suppressed recipients without attempting delivery', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addLead(11, 1, 'bob@example.com'); addCampaign(1, 1);
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (1, 10, 'pending'), (1, 11, 'pending')").run();
  unsub.suppress({ userId: 1, email: 'jane@example.com', reason: 'unsubscribe' });

  const { results } = await campaignsService.sendCampaign(1, 1);
  const byLead = Object.fromEntries(results.map((r) => [r.leadId, r.status]));
  assert.equal(byLead[10], 'suppressed');
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE lead_id = 10').get().status, 'pending', 'never marked sent');
  assert.notEqual(byLead[11], 'suppressed', 'other recipients are still attempted');
});

test('the follow-up queue skips suppressed recipients', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1);
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, scheduled_at) VALUES (1, 10, 1, 'email', '<p>Follow-up</p>', 'pending', datetime('now', '-1 minute'))").run();
  // Suppressed directly (e.g. via another campaign) without touching this queue row.
  db.prepare("INSERT INTO email_suppressions (user_id, email_hash, reason) VALUES (1, ?, 'unsubscribe')").run(unsub.emailHash('jane@example.com'));
  await processOutreachQueue();
  assert.equal(db.prepare('SELECT status FROM outreach_queue WHERE lead_id = 10').get().status, 'skipped');
});
