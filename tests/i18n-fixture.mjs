import { readFileSync } from 'node:fs';
export const catalogs = Object.fromEntries(['en', 'ru'].map(locale => [locale,
  JSON.parse(readFileSync(new URL(`../extension/_locales/${locale}/messages.json`, import.meta.url), 'utf8'))]));
export function mockI18n(locale) {
  return {
    getUILanguage: () => locale,
    getMessage: (key, substitutions = []) => (catalogs[locale]?.[key] ?? catalogs.en[key])?.message
      .replace(/\$(\d+)/g, (_, number) => substitutions[Number(number) - 1] ?? '') ?? '',
  };
}
globalThis.chrome = { i18n: mockI18n('ru') };
export { t } from '../extension/i18n.js';
// VM popup tests supply imported functions through their context.
export const popupSource = source => source.replace(/^import .* from '\.\/i18n\.js';\n/m, '');
