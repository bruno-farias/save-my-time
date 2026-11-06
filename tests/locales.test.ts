import { afterEach, expect, it } from 'vitest';
import { interfaceLanguages, languages, resolveLanguage, translate } from '../src/locales/catalog';
import { validateLanguage } from '../src/locales/validation';
import { setInterfaceLanguage, t } from '../src/lib/i18n';
import { defaultSettings, normalizeSettings } from '../src/lib/settings';
import { prepareInput } from '../src/lib/prompts';
import { article } from './fixtures';

const english = languages.find(language => language.code === 'en')!;
afterEach(() => setInterfaceLanguage('en'));
it('automatically registers all JSON files and validates complete shipped interface translations', () => {
  expect(languages.length).toBeGreaterThanOrEqual(32); expect(interfaceLanguages.map(language => language.code)).toEqual(expect.arrayContaining(['en', 'es', 'it', 'pt']));
  for (const language of languages) {
    expect(validateLanguage(language, language.code, english.messages)).toEqual([]);
    if (['en', 'es', 'it', 'pt'].includes(language.code)) expect(Object.keys(language.messages)).toEqual(Object.keys(english.messages));
    expect(normalizeSettings({ language: language.code }).language).toBe(language.code);
  }
});
it('resolves browser and regional preferences and falls back to English', () => {
  expect(resolveLanguage('auto', ['x-unsupported-test', 'pt']).code).toBe('pt');
  expect(resolveLanguage('es-x-test-fixture').code).toBe('es');
  expect(resolveLanguage('IT').code).toBe('it');
  expect(resolveLanguage('auto', ['unknown']).code).toBe('en');
  expect(resolveLanguage('x-unsupported-test').code).toBe('en');
});
it('interpolates named values, preserves unknown placeholders, and safely falls back for missing strings', () => {
  expect(translate(resolveLanguage('pt'), '{provider} settings', { provider: 'OpenAI' })).toBe('Configurações de OpenAI');
  expect(translate(english, 'Unknown {thing}')).toBe('Unknown {thing}');
  expect(translate(english, 'toString')).toBe('toString');
  expect(translate(english, '__proto__')).toBe('__proto__');
  expect(translate({ ...english, messages: {} }, 'Master password')).toBe('Master password');
});
it('rejects misspelled metadata, invalid tags and translation placeholders while allowing partial contributions', () => {
  const contribution = { ...english, code: 'pt-BR', nativeName: 'Português do Brasil', messages: { '{provider} settings': 'Configurações de {provider}' } };
  expect(validateLanguage(contribution, 'pt-BR', english.messages)).toEqual([]);
  expect(validateLanguage({ ...contribution, code: 'pt_BR', extra: true }, 'pt', english.messages).length).toBeGreaterThan(0);
  expect(validateLanguage({ ...contribution, messages: { '{provider} settings': 'Configurações de {providerName}' } }, 'pt-BR', english.messages)).toContain('Placeholder mismatch: {provider} settings');
  expect(validateLanguage({ ...contribution, messages: { unknown: 'Teste' } }, 'pt-BR', english.messages)).toContain('Unknown message: unknown');
  expect(validateLanguage({ ...contribution, messages: { 'Settings': '' } }, 'pt-BR', english.messages)).toContain('Empty or invalid translation: Settings');
  expect(validateLanguage({ ...contribution, interface: false, messages: {} }, 'pt-BR', english.messages)).toEqual([]);
});
it('updates document language and leaves AI output independent of the interface', () => {
  const settings = defaultSettings(); settings.uiLanguage = 'it'; settings.language = 'ar';
  setInterfaceLanguage(settings.uiLanguage);
  expect(document.documentElement.lang).toBe('it'); expect(document.documentElement.dir).toBe('ltr'); expect(t('Settings')).toBe('Impostazioni');
  expect(prepareInput(article, [], settings).system).toContain('العربية');
  expect(prepareInput(article, [], settings).outputLanguage).toBe('ar');
  expect(normalizeSettings(settings).language).toBe('ar');
  expect(languages.find(language => language.code === 'ar')?.direction).toBe('rtl');
});
