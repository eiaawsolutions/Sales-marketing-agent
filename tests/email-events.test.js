import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const dir = mkdtempSync(path.join(tmpdir(), 'sa-email-events-'));
process.env.SA_DB_PATH = path.join(dir, 'test.db');
delete process.env.RESEND_API_KEY; // no real email leaves a test
delete process.env.SMTP_HOST;

const SECRET = `whsec_${crypto.randomBytes(24).toString('base64')}`;
process.env.RESEND_WEBHOOK_SIGNING_SECRET = SECRET;

const { default: db } = await import('../src/db/index.js');
const unsub = await import('../src/services/unsubscribe.js');
const { campaignsService } = await import('../src/services/campaigns.js');
const { processOutreachQueue } = await import('../src/services/scheduler.js');
const { default: trackingRouter } = await import('../src/routes/tracking.js');

after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function reset() {
  for (const t of ['email_suppressions', 'outreach_queue', 'campaign_leads', 'activities', 'leads', 'campaigns', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key IN ('resend_api_key','smtp_host','smtp_user')").run();
  process.env.RESEND_WEBHOOK_SIGNING_SECRET = SECRET;
}
function addUser(id) {
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, plan) VALUES (?, ?, ?, 'x', 'user', 'active', 'pro')`)
    .run(id, `user${id}`, `owner${id}@example.com`);
}
function addLead(id, userId, email) {
  db.prepare('INSERT INTO leads (id, user_id, name, email, score) VALUES (?, ?, ?, ?, 0)').run(id, userId, `Lead ${id}`, email);
}
function addCampaign(id, userId) {
  db.prepare("INSERT INTO campaigns (id, user_id, name, type, status, subject, body) VALUES (?, ?, ?, 'email', 'active', 'Hi', '<p>Hello</p>')")
    .run(id, userId, `Campaign ${id}`);
}
function addSent(campaignId, leadId, emailId) {
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status, sent_at, provider_message_id) VALUES (?, ?, 'sent', CURRENT_TIMESTAMP, ?)")
    .run(campaignId, leadId, emailId);
}
function addPendingFollowUp(campaignId, leadId) {
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, scheduled_at) VALUES (?, ?, 2, 'email', '<p>Again</p>', 'pending', datetime('now', '+1 day'))")
    .run(campaignId, leadId);
}

function event(type, emailId, to) {
  return JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: emailId, to: [to], from: 'EIAAW SalesAgent <sales@eiaawsolutions.com>', subject: 'Hi' } });
}
function signed(body, { secret = SECRET, id = `msg_${crypto.randomUUID()}`, ts = Math.floor(Date.now() / 1000) } = {}) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

// Mirrors server.js: the raw-body parser sits before express.json().
async function withServer(fn) {
  const app = express();
  app.use('/api/tracking/webhook', express.raw({ type: 'application/json', limit: '256kb' }));
  app.use(express.json());
  app.use('/api/tracking', trackingRouter);
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}/api/tracking/webhook`); } finally { server.close(); }
}
const post = (url, body, headers) => fetch(url, { method: 'POST', body, headers });

beforeEach(reset);

test('unsigned and forged events are rejected and change nothing', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1); addSent(1, 10, 'em_1');
  await withServer(async (url) => {
    const body = event('email.complained', 'em_1', 'jane@example.com');
    const unsigned = await post(url, body, { 'Content-Type': 'application/json' });
    assert.equal(unsigned.status, 401);

    const forged = await post(url, body, signed(body, { secret: `whsec_${crypto.randomBytes(24).toString('base64')}` }));
    assert.equal(forged.status, 401);

    const opened = event('email.opened', 'em_1', 'jane@example.com');
    const tampered = await post(url, opened, signed(body)); // signature over a different body
    assert.equal(tampered.status, 401);
  });
  assert.ok(!unsub.isSuppressed(1, 'jane@example.com'));
  assert.equal(db.prepare('SELECT status FROM campaign_leads').get().status, 'sent');
  assert.equal(db.prepare('SELECT open_count FROM campaigns').get().open_count, 0);
});

test('replayed deliveries outside the five-minute window are rejected', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1); addSent(1, 10, 'em_1');
  await withServer(async (url) => {
    const body = event('email.complained', 'em_1', 'jane@example.com');
    const res = await post(url, body, signed(body, { ts: Math.floor(Date.now() / 1000) - 3600 }));
    assert.equal(res.status, 401);
  });
  assert.ok(!unsub.isSuppressed(1, 'jane@example.com'));
});

test('fails closed when no signing secret is configured', async () => {
  delete process.env.RESEND_WEBHOOK_SIGNING_SECRET;
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1); addSent(1, 10, 'em_1');
  await withServer(async (url) => {
    const body = event('email.complained', 'em_1', 'jane@example.com');
    const res = await post(url, body, signed(body));
    assert.equal(res.status, 503);
  });
  assert.ok(!unsub.isSuppressed(1, 'jane@example.com'));
});

test('a spam complaint puts the recipient on the sending account\'s do-not-email list', async () => {
  addUser(1); addUser(2);
  addLead(10, 1, 'Jane@Example.com'); addLead(20, 2, 'jane@example.com');
  addCampaign(1, 1); addCampaign(2, 2);
  addSent(1, 10, 'em_1'); addSent(2, 20, 'em_2');
  addPendingFollowUp(1, 10); addPendingFollowUp(2, 20);

  await withServer(async (url) => {
    const body = event('email.complained', 'em_1', 'Jane@Example.com');
    const res = await post(url, body, signed(body));
    assert.equal(res.status, 200);
    // Svix retries until it gets a 2xx; a repeat delivery must change nothing.
    const again = await post(url, body, signed(body));
    assert.equal(again.status, 200);
  });

  const rows = db.prepare('SELECT user_id, reason, campaign_id, lead_id FROM email_suppressions').all();
  assert.deepEqual(rows, [{ user_id: 1, reason: 'complaint', campaign_id: 1, lead_id: 10 }]);
  assert.ok(unsub.isSuppressed(1, 'jane@example.com'));
  assert.ok(!unsub.isSuppressed(2, 'jane@example.com'), 'another account that emailed the same address is not affected');
  assert.equal(db.prepare('SELECT status FROM outreach_queue WHERE lead_id = 10').get().status, 'skipped');
  assert.equal(db.prepare('SELECT status FROM outreach_queue WHERE lead_id = 20').get().status, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activities WHERE lead_id = 10").get().c, 1, 'one activity, not one per retry');
});

test('opened and clicked events move only the matching send, once', async () => {
  addUser(1); addUser(2);
  addLead(10, 1, 'jane@example.com'); addLead(20, 2, 'jane@example.com');
  addCampaign(1, 1); addCampaign(2, 2);
  addSent(1, 10, 'em_1'); addSent(2, 20, 'em_2');

  await withServer(async (url) => {
    const opened = event('email.opened', 'em_1', 'jane@example.com');
    assert.equal((await post(url, opened, signed(opened))).status, 200);
    assert.equal((await post(url, opened, signed(opened))).status, 200);
    const clicked = event('email.clicked', 'em_1', 'jane@example.com');
    assert.equal((await post(url, clicked, signed(clicked))).status, 200);
  });

  const c1 = db.prepare('SELECT open_count, click_count FROM campaigns WHERE id = 1').get();
  assert.deepEqual({ ...c1 }, { open_count: 1, click_count: 1 });
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = 1').get().status, 'clicked');
  assert.equal(db.prepare('SELECT score FROM leads WHERE id = 10').get().score, 15);

  const c2 = db.prepare('SELECT open_count, click_count FROM campaigns WHERE id = 2').get();
  assert.deepEqual({ ...c2 }, { open_count: 0, click_count: 0 });
  assert.equal(db.prepare('SELECT status FROM campaign_leads WHERE campaign_id = 2').get().status, 'sent');
  assert.equal(db.prepare('SELECT score FROM leads WHERE id = 20').get().score, 0);
});

test('a bounce marks the send bounced and cancels that lead\'s pending follow-ups in the campaign', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1); addSent(1, 10, 'em_1'); addPendingFollowUp(1, 10);
  await withServer(async (url) => {
    const body = event('email.bounced', 'em_1', 'jane@example.com');
    assert.equal((await post(url, body, signed(body))).status, 200);
  });
  assert.equal(db.prepare('SELECT status FROM campaign_leads').get().status, 'bounced');
  assert.equal(db.prepare('SELECT status FROM outreach_queue').get().status, 'skipped');
});

test('events for mail this app did not send as outreach are ignored', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1); addSent(1, 10, 'em_1');
  await withServer(async (url) => {
    // Same recipient, but a different email (sign-up mail, another app on the Resend account).
    for (const type of ['email.complained', 'email.opened', 'email.bounced']) {
      const body = event(type, 'em_unknown', 'jane@example.com');
      assert.equal((await post(url, body, signed(body))).status, 200);
    }
  });
  assert.ok(!unsub.isSuppressed(1, 'jane@example.com'));
  assert.equal(db.prepare('SELECT status FROM campaign_leads').get().status, 'sent');
  assert.equal(db.prepare('SELECT open_count FROM campaigns').get().open_count, 0);
});

test('campaign sends and follow-ups record Resend\'s email id', async () => {
  addUser(1); addLead(10, 1, 'jane@example.com'); addCampaign(1, 1);
  db.prepare("INSERT INTO campaign_leads (campaign_id, lead_id, status) VALUES (1, 10, 'pending')").run();
  db.prepare("INSERT INTO outreach_queue (campaign_id, lead_id, step, channel, message, status, scheduled_at) VALUES (1, 10, 2, 'email', '<p>Again</p>', 'pending', datetime('now', '-1 minute'))").run();

  const realFetch = globalThis.fetch;
  let n = 0;
  process.env.RESEND_API_KEY = 're_test_key_not_real';
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://api.resend.com/')) {
      n += 1;
      return new Response(JSON.stringify({ id: `em_sent_${n}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    await campaignsService.sendCampaign(1, 1);
    await processOutreachQueue();
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
  assert.equal(db.prepare('SELECT provider_message_id FROM campaign_leads').get().provider_message_id, 'em_sent_1');
  assert.equal(db.prepare('SELECT provider_message_id FROM outreach_queue').get().provider_message_id, 'em_sent_2');
});
