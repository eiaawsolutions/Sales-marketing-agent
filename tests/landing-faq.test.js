import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/landing.html', import.meta.url), 'utf8');
const { document } = new JSDOM(html).window;

const graph = [...document.querySelectorAll('script[type="application/ld+json"]')]
  .flatMap((s) => JSON.parse(s.textContent)['@graph'] || []);
const faqPage = graph.find((n) => n['@type'] === 'FAQPage');
const structured = faqPage.mainEntity.map((q) => ({ q: q.name, a: q.acceptedAnswer.text }));

const items = [...document.querySelectorAll('#faq .faq-item')];
const visible = items.map((d) => ({
  q: d.querySelector('summary h3').textContent.trim(),
  a: d.querySelector('.faq-a').textContent.trim(),
}));

test('visible FAQ matches the FAQPage JSON-LD word for word', () => {
  assert.deepEqual(visible, structured);
});

test('FAQ numbering is sequential and the range label matches the count', () => {
  const nums = items.map((d) => d.querySelector('.num').textContent.trim());
  assert.deepEqual(nums, items.map((_, i) => String(i + 1).padStart(2, '0')));
  const label = document.querySelector('#faq .aside').textContent.replace(/\s+/g, ' ').trim();
  assert.equal(label, `Questions · 01–${nums.at(-1)}`);
});

test('FAQ states that we do not sell contact lists or personal phone numbers', () => {
  const entry = structured.find((e) => /contact lists/i.test(e.q));
  assert.ok(entry, 'contact-list FAQ entry missing');
  assert.match(entry.a, /^No\. We don't sell, rent or supply contact lists/);
  assert.match(entry.a, /purchased consumer lists/);
});
