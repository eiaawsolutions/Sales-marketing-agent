import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { TERMS_VERSION, PRIVACY_VERSION, DPA_VERSION } from '../src/config/legal.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const terms = read('../public/terms.html');
const privacy = read('../public/privacy.html');
const dpa = read('../public/dpa.html');
const security = read('../public/security.html');
const landing = read('../public/landing.html');
const sitemap = read('../public/sitemap.xml');

test('published versions match the versions checkout records', () => {
  assert.ok(terms.includes(`Version <strong>${TERMS_VERSION}</strong>`), 'terms.html version drifted from src/config/legal.js');
  assert.ok(privacy.includes(`Version <strong>${PRIVACY_VERSION}</strong>`), 'privacy.html version drifted from src/config/legal.js');
  assert.ok(dpa.includes(`Version <strong>${DPA_VERSION}</strong>`), 'dpa.html version drifted from src/config/legal.js');
});

test('superseded versions are archived, linked and kept out of search', () => {
  for (const [page, file] of [[terms, 'terms-2026-04-19.html'], [privacy, 'privacy-2026-09-24.html']]) {
    assert.ok(page.includes(`/legal/archive/${file}`), `current page does not link ${file}`);
    const url = new URL(`../public/legal/archive/${file}`, import.meta.url);
    assert.ok(existsSync(url), `${file} missing`);
    const archived = readFileSync(url, 'utf8');
    assert.match(archived, /<meta name="robots" content="noindex, follow">/);
    assert.match(archived, /Archived version\./);
    assert.ok(!sitemap.includes(file), `${file} must not be in the sitemap`);
  }
});

test('the DPA is linked from terms, privacy, security, the landing footer and the sitemap', () => {
  for (const [name, page] of Object.entries({ terms, privacy, security, landing })) {
    assert.ok(page.includes('href="/dpa.html'), `${name} does not link the DPA`);
  }
  assert.ok(sitemap.includes('<loc>https://sa.eiaawsolutions.com/dpa.html</loc>'));
});

test('operator identity: an enterprise, never a company or Sdn Bhd', () => {
  for (const [name, page] of Object.entries({ terms, privacy, dpa })) {
    assert.ok(page.includes('an enterprise registered in Malaysia'), `${name} lacks the entity line`);
    assert.ok(!/Sdn\.? Bhd/i.test(page), `${name} says Sdn Bhd`);
    assert.ok(!/Malaysia-based company/i.test(page), `${name} calls EIAAW a company`);
  }
});

test('tax: not SST-registered, and nothing implies tax is added on top', () => {
  assert.match(terms, /not registered for Sales and Service Tax \(SST\), so no SST is charged/);
  assert.match(landing, /not registered for Sales and Service Tax \(SST\), so no SST is charged/);
  assert.match(landing, /tidak berdaftar untuk Cukai Jualan dan Perkhidmatan \(SST\)/);
  for (const page of [terms, landing]) assert.ok(!/exclusive of taxes/i.test(page));
});

test('harmonised timelines: 48h customer breach notice, 30 days for sub-processors and changes', () => {
  assert.match(dpa, /within 48 hours of becoming aware/);
  assert.match(privacy, /within 48 hours of becoming aware/);
  assert.match(security, /within 48 hours of our becoming aware/);
  assert.ok(!/within 24 hours where their data/.test(security));
  assert.match(privacy, /within 7 days of notifying the Commissioner/);
  for (const page of [privacy, dpa, security]) assert.match(page, /30 days before adding or replacing a sub-processor/);
  assert.match(terms, /at least 30 days before a material change takes effect/);
  assert.match(terms, /refund any prepaid fees for the unused part/);
});

test('no claim of a self-serve export; export on request within 14 days', () => {
  for (const page of [terms, privacy, dpa]) {
    assert.ok(!/in-app export/i.test(page));
    assert.match(page, /within 14 days/);
  }
});

test('Apollo.io is disclosed as a lead source and a recipient (EN and BM)', () => {
  assert.match(privacy, /<tr><td>Apollo\.io<\/td>/);
  assert.match(privacy, /B2B contact database of <strong>Apollo\.io<\/strong>/);
  assert.match(privacy, /pangkalan data kenalan B2B <strong>Apollo\.io<\/strong>/);
  assert.match(privacy, /Apollo\.io \(data kenalan perniagaan untuk penjanaan prospek, Amerika Syarikat\)/);
});

test('no visible placeholders left in published legal pages', () => {
  for (const [name, page] of Object.entries({ terms, privacy, dpa, security, landing })) {
    assert.ok(!/\[(?:OI-\d+|street address|date of publication)[^\]]*\]/i.test(page), `${name} has a placeholder`);
  }
});
