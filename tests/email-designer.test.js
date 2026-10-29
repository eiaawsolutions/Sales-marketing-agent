import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The email designer (public/email-designer.js), run in a browser window.
// On 28 Oct 2026 a campaign's email was saved as HTML only: the designer's
// blocks were thrown away, so Edit opened the starter "Welcome" design, and
// the Review step's Preview put that starter design into the campaign — the
// next save would have sent it to every lead still waiting.
const src = readFileSync(new URL('../public/email-designer.js', import.meta.url), 'utf8');

function page() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://sa.eiaawsolutions.com/app', runScripts: 'outside-only' });
  dom.window.eval(src);
  return dom.window;
}

function design(win, overrides = {}) {
  const d = win.EmailDesigner.defaultDesign();
  d.brand = { ...d.brand, logoUrl: 'https://sa.eiaawsolutions.com/media/logo.png', bgColor: '#F3EDE0', textColor: '#1A2A2E', accentColor: '#0E5C53',
    font: "Georgia, 'Times New Roman', serif" };
  d.header = { ...d.header, align: 'left' };
  d.blocks = [
    { type: 'h1', text: 'AI that does the work.', align: 'left' },
    { type: 'h2', text: 'Five products, ready to use', align: 'center' },
    { type: 'h3', text: 'SalesAgent & "friends"', align: 'right' },
    { type: 'p', text: "I'm Amos.\nCo-founder.\n\nPick a time: https://cal.com/amos/30min.", align: 'left' },
    { type: 'image', url: 'https://sa.eiaawsolutions.com/media/hero.png', alt: 'Hero' },
    { type: 'cta', text: 'Book a call', url: 'https://cal.com/amos/30min', bg: '#1FA896', color: '#FFFFFF', size: 'lg', align: 'center' },
    { type: 'divider' },
    { type: 'spacer', height: 40 },
    { type: 'html', html: '<p>Written by <strong>AI</strong>.</p>' },
  ];
  d.footer = { ...d.footer, companyName: 'EIAAW Solutions', address: 'Kuala Lumpur', phone: '+60 12-345 6789',
    social: { facebook: 'https://facebook.com/eiaaw', instagram: '', linkedin: 'https://linkedin.com/in/eiaaw', x: '', youtube: '' } };
  return Object.assign(d, overrides);
}

test('a saved email is read back into the same blocks, so Edit reopens the same layout', () => {
  const win = page();
  const html = win.EmailDesigner.compile(design(win));
  const back = win.EmailDesigner.fromHtml(html);
  assert.ok(back, 'the designer recognised its own email');
  assert.equal(win.EmailDesigner.compile(back), html);
  assert.deepEqual([...back.blocks.map(b => b.type)], ['h1', 'h2', 'h3', 'p', 'image', 'cta', 'divider', 'spacer', 'html']);
  assert.equal(back.blocks[3].text, "I'm Amos.\nCo-founder.\n\nPick a time: https://cal.com/amos/30min.");
  assert.equal(back.brand.logoUrl, 'https://sa.eiaawsolutions.com/media/logo.png');
  assert.equal(back.footer.companyName, 'EIAAW Solutions');
  assert.equal(back.footer.phone, '+60 12-345 6789');
  assert.equal(back.footer.social.linkedin, 'https://linkedin.com/in/eiaaw');
  assert.equal(back.mode, 'scratch');
});

test('a layout with no logo, no footer and a lone phone line reads back the same', () => {
  const win = page();
  const d = design(win);
  d.brand.logoUrl = '';
  d.footer = { ...d.footer, show: false };
  const html = win.EmailDesigner.compile(d);
  assert.equal(win.EmailDesigner.compile(win.EmailDesigner.fromHtml(html)), html);

  const d2 = design(win);
  d2.footer = { ...d2.footer, address: '', social: { facebook: '', instagram: '', linkedin: '', x: '', youtube: '' } };
  const html2 = win.EmailDesigner.compile(d2);
  const back2 = win.EmailDesigner.fromHtml(html2);
  assert.equal(win.EmailDesigner.compile(back2), html2);
  assert.equal(back2.footer.phone, '+60 12-345 6789');
});

test('HTML the designer did not make is not read as a design', () => {
  const win = page();
  assert.equal(win.EmailDesigner.fromHtml('<p>Hello there</p>'), null);
  assert.equal(win.EmailDesigner.fromHtml('<!DOCTYPE html><html><body><table><tr><td>AI email</td></tr></table></body></html>'), null);
  assert.equal(win.EmailDesigner.fromHtml(''), null);
});

test('a link typed into a paragraph is a real link in the email', () => {
  const win = page();
  const html = win.EmailDesigner.compile(design(win));
  assert.match(html, /<a href="https:\/\/cal\.com\/amos\/30min"[^>]*>https:\/\/cal\.com\/amos\/30min<\/a>\./);
  // The text around it is still escaped.
  assert.match(html, /I&#39;m Amos\.<br>Co-founder\./);
});

test('previewing with no design open never puts the starter design into the campaign', () => {
  const win = page();
  win.wizardState = { data: { body: '<p>The email already sent</p>', design: null } };
  win.EmailDesigner.openPreview(null);
  assert.equal(win.wizardState.data.design, null);
  assert.equal(win.wizardState.data.body, '<p>The email already sent</p>');
  win.EmailDesigner.openPreviewHtml('<p>The email already sent</p>');
  assert.equal(win.document.getElementById('ed-preview-iframe').srcdoc, '<p>The email already sent</p>');
});
