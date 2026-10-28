import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { catalogs, mockI18n } from './i18n-fixture.mjs';
import { t, localizeDocument } from '../extension/i18n.js';
import { createStatusBadge } from '../extension/badge.js';
import { createConnection } from '../extension/connection.js';

test('both catalogs cover every UI message and preserve substitution slots', async () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs.ru).sort());
  for (const [key, entry] of Object.entries(catalogs.en)) {
    assert.ok(entry.message.trim(), key);
    assert.ok(catalogs.ru[key].message.trim(), key);
    assert.deepEqual(entry.message.match(/\$\d+/g), catalogs.ru[key].message.match(/\$\d+/g), key);
  }
  const files = (await readdir('extension')).filter(name => /\.(js|html)$/.test(name));
  for (const file of files) {
    const source = await readFile(`extension/${file}`, 'utf8');
    const keys = [...source.matchAll(/\bt\('([^']+)'|data-i18n(?:-placeholder|-aria-label)?="([^"]+)"|title: '(badge_[^']+)'/g)];
    for (const match of keys) assert.ok(catalogs.en[match[1] ?? match[2] ?? match[3]], `${file}: ${match[0]}`);
  }
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.equal(manifest.default_locale, 'en');
  assert.ok(catalogs.en[manifest.description.match(/^__MSG_(.+)__$/)[1]]);
});

for (const locale of ['en', 'ru', 'de']) test(`popup, connection and badge use ${locale} locale with English fallback`, async () => {
  globalThis.chrome = { i18n: mockI18n(locale) };
  const expected = catalogs[locale] ?? catalogs.en;
  const text = { dataset: { i18n: 'connect' } };
  const attributes = {};
  const placeholder = { getAttribute: () => 'secret_placeholder', setAttribute: (key, value) => { attributes[key] = value; } };
  const document = { documentElement: {}, querySelectorAll: selector => selector === '[data-i18n]' ? [text]
    : selector === '[data-i18n-placeholder]' ? [placeholder] : [] };
  localizeDocument(document);
  assert.equal(document.documentElement.lang, locale === 'ru' ? 'ru' : 'en');
  assert.equal(text.textContent, expected.connect.message);
  assert.equal(attributes.placeholder, expected.secret_placeholder.message);
  assert.equal(t('finish_failed', ['<error>']), expected.finish_failed.message.replace('$1', '<error>'));
  let title;
  await createStatusBadge({ action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
    setTitle: async value => { title = value.title; } } })('stale');
  assert.equal(title, `turbo-figma: ${expected.badge_stale.message}`);
  const connection = createConnection({ storage: { local: { get: async () => ({}) }, session: { get: async () => ({}) } } },
    { createCollector: () => undefined });
  await connection.ready;
  const status = await connection.control({ action: 'status' });
  assert.equal(status.message, expected.disconnected.message);
  assert.equal(status.capture.message, expected.capture_requirements.message);
});
