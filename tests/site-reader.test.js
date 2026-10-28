import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const reader = await import('../src/services/site-reader.js');

const realFetch = globalThis.fetch;
const ENV = { CRAWL4AI_URL: 'http://crawl4ai.railway.internal:11235', CRAWL4AI_API_TOKEN: 'test-token' };
beforeEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(process.env, ENV);
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

// Crawl4AI /md stub: one markdown body per URL; records every request.
function crawler(pages) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, auth: init.headers.Authorization });
    if (!(body.url in pages)) return new Response(JSON.stringify({ detail: 'Crawl failed' }), { status: 500 });
    return new Response(JSON.stringify({ url: body.url, markdown: pages[body.url], success: true }), { status: 200 });
  };
  return calls;
}

test('only public http(s) websites are read', () => {
  assert.equal(reader.safeSiteUrl('https://velora.example/')?.href, 'https://velora.example/');
  assert.equal(reader.safeSiteUrl('velora.example')?.href, 'https://velora.example/');
  for (const bad of [
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/', 'http://localhost/', 'http://crawl4ai.railway.internal:11235/',
    'http://intranet.local/', 'ftp://velora.example/', 'https://user:pw@velora.example/', 'https://velora.example:8443/',
    'javascript:alert(1)', '', null,
  ]) {
    assert.equal(reader.safeSiteUrl(bad), null, String(bad));
  }
});

test("a person's published work email is matched to them on the page", () => {
  const page = 'Our team\n\nLee Shu Fen — Director, L&D — shufen.lee@velora.example\n\nJason Lee — Sales — jason.lee@velora.example\n\nGeneral enquiries: info@velora.example';
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', page, 'velora.example'), 'shufen.lee@velora.example');
});

test('nothing is matched when the person is not named on the page', () => {
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', 'Contact jason.lee@velora.example', 'velora.example'), null);
});

test('an address on another domain is not taken as their work email', () => {
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', 'Lee Shu Fen: shufenlee88@gmail.com', 'velora.example'), null);
});

test('a role inbox is never taken as a person', () => {
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', 'Lee Shu Fen, Director. Email lee@velora.example or hr@velora.example', 'velora.example'), 'lee@velora.example');
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', 'Lee Shu Fen, Director. Email hr@velora.example', 'velora.example'), null);
});

test('two equally good matches are ambiguous, so neither is used', () => {
  const page = 'Lee Shu Fen and Lee Wei both lead L&D: lee.sf@velora.example, lee.w@velora.example';
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', page, 'velora.example'), null);
});

test('image names that look like addresses are ignored', () => {
  assert.equal(reader.matchPublishedEmail('Lee Shu Fen', 'Lee Shu Fen ![logo](/img/lee@2x.png)', 'velora.example'), null);
});

test('a two-letter surname still matches when it is its own part of the address', () => {
  assert.equal(reader.matchPublishedEmail('Ng Wei Ming', 'Ng Wei Ming, CEO — weiming.ng@harbour.example', 'harbour.example'), 'weiming.ng@harbour.example');
});

test('the address may sit on the main domain of a www or sub-domain site', () => {
  assert.equal(reader.matchPublishedEmail('Ng Wei Ming', 'Ng Wei Ming weiming.ng@harbour.example', 'www.harbour.example'), 'weiming.ng@harbour.example');
});

test("the team, about and contact pages are picked from the site's own links", () => {
  const md = '[Home](/) [Our Team](/our-team) [About us](https://velora.example/about) [Contact](/contact-us) [Careers](/careers) [Blog](/blog) [Partner](https://other.example/team) [Profile PDF](/files/team.pdf) [Leadership](/leadership)';
  const pages = reader.peoplePages(md, new URL('https://velora.example/')).map(u => u.href);
  assert.deepEqual(pages, ['https://velora.example/our-team', 'https://velora.example/leadership', 'https://velora.example/about']);
});

test("the reader finds the email on the company's team page and keeps that page as evidence", async () => {
  const calls = crawler({
    'https://velora.example/': 'Velora — learning for manufacturers. [Our team](/our-team) [Contact](/contact)',
    'https://velora.example/our-team': '## Leadership\n\nLee Shu Fen\nDirector, L&D\n[shufen.lee@velora.example](mailto:shufen.lee@velora.example)',
  });
  const found = await reader.findPublishedEmail({ name: 'Lee Shu Fen', company_website: 'https://velora.example/' });
  assert.deepEqual(found, { email: 'shufen.lee@velora.example', page: 'https://velora.example/our-team' });
  assert.equal(calls[0].url, 'http://crawl4ai.railway.internal:11235/md');
  assert.equal(calls[0].auth, 'Bearer test-token');
  assert.deepEqual(calls[0].body, { url: 'https://velora.example/', f: 'raw' });
});

test('a page that fails to load does not stop the reader trying the next one', async () => {
  crawler({
    'https://velora.example/': '[Team](/team) [About](/about)',
    'https://velora.example/about': 'Lee Shu Fen, founder. shufen@velora.example',
  });
  const found = await reader.findPublishedEmail({ name: 'Lee Shu Fen', company_website: 'https://velora.example/' });
  assert.equal(found?.email, 'shufen@velora.example');
});

test('without the service, or for an unsafe website, nothing is fetched', async () => {
  const calls = crawler({});
  delete process.env.CRAWL4AI_URL;
  assert.equal(await reader.findPublishedEmail({ name: 'Lee Shu Fen', company_website: 'https://velora.example/' }), null);
  process.env.CRAWL4AI_URL = ENV.CRAWL4AI_URL;
  assert.equal(await reader.findPublishedEmail({ name: 'Lee Shu Fen', company_website: 'http://169.254.169.254/' }), null);
  assert.equal(calls.length, 0);
});

test('the health check reports the running Crawl4AI version', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    return new Response(JSON.stringify({ status: 'ok', version: '0.9.5' }), { status: 200 });
  };
  assert.deepEqual(await reader.pingSiteReader(), { configured: true, ok: true, version: '0.9.5' });
  assert.deepEqual(calls, [{ url: 'http://crawl4ai.railway.internal:11235/health', method: 'GET' }]);
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND crawl4ai.railway.internal'); };
  assert.equal((await reader.pingSiteReader()).ok, false);
  delete process.env.CRAWL4AI_API_TOKEN;
  assert.deepEqual(await reader.pingSiteReader(), { configured: false, ok: false });
});
