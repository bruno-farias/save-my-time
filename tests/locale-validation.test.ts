import { expect, it } from 'vitest';
import { placeholders, validateLanguage } from '../src/locales/validation';
import { resolveLanguage, translate, languages } from '../src/locales/catalog';

const english = { Settings: 'Settings', 'Hello {name} at {count}': 'Hello {name} at {count}' };
const valid = { code: 'pt-BR', name: 'Portuguese', nativeName: 'Português', direction: 'ltr', interface: true, messages: { Settings: 'Configurações' } };
it.each([null, undefined, false, 1, 'pt-BR', []])('rejects non-object locale input: %j', value => {
  expect(validateLanguage(value, 'pt-BR', english)).toEqual(['Expected a JSON object.']);
});
it.each([
  [{ code: 'PT-br' }, 'code must be a canonical BCP 47 language tag, such as pt or pt-BR.'],
  [{ code: 'auto' }, 'code must be a canonical BCP 47 language tag, such as pt or pt-BR.'],
  [{ code: 1 }, 'code must be a canonical BCP 47 language tag, such as pt or pt-BR.'],
  [{ code: 'it' }, 'The filename must match code.'],
  [{ name: '' }, 'name must be a nonempty string.'],
  [{ name: 1 }, 'name must be a nonempty string.'],
  [{ nativeName: '  ' }, 'nativeName must be a nonempty string.'],
  [{ nativeName: false }, 'nativeName must be a nonempty string.'],
  [{ direction: 'up' }, 'direction must be ltr or rtl.'],
  [{ interface: 'true' }, 'interface must be true or false.'],
  [{ messages: null }, 'messages must be an object.'],
  [{ messages: [] }, 'messages must be an object.'],
  [{ messages: 'text' }, 'messages must be an object.'],
  [{ messages: {} }, 'An interface language needs at least one translation.'],
  [{ messages: { Settings: 42 } }, 'Empty or invalid translation: Settings'],
  [{ messages: { Settings: '  ' } }, 'Empty or invalid translation: Settings'],
  [{ messages: { toString: 'inherited key' } }, 'Unknown message: toString'],
  [{ extra: 'invalid' }, 'Unknown field: extra'],
])('reports invalid locale metadata or messages: %j', (change, error) => {
  expect(validateLanguage({ ...valid, ...change }, 'pt-BR', english)).toContain(error);
});
it('allows RTL, schema metadata, partial translations, and output-only languages', () => {
  expect(validateLanguage({ ...valid, direction: 'rtl', $schema: '../schema.json' }, 'pt-BR', english)).toEqual([]);
  expect(validateLanguage({ ...valid, interface: false, messages: {} }, 'pt-BR', english)).toEqual([]);
});
it('compares placeholder sets independent of order and repetition', () => {
  expect(placeholders('{name} {count} {name} {file_2} {A} {1invalid}')).toEqual(['A', 'count', 'file_2', 'name']);
  expect(validateLanguage({ ...valid, messages: { 'Hello {name} at {count}': '{count}: Olá {name}, {name}' } }, 'pt-BR', english)).toEqual([]);
  expect(validateLanguage({ ...valid, messages: { 'Hello {name} at {count}': 'Olá {name}' } }, 'pt-BR', english)).toContain('Placeholder mismatch: Hello {name} at {count}');
});
it('does not use output-only languages for the interface and preserves browser preference order', () => {
  expect(resolveLanguage('ar').code).toBe('en');
  expect(resolveLanguage('auto', ['ar', 'it-IT', 'pt']).code).toBe('it');
  expect(resolveLanguage('auto', []).code).toBe('en');
  expect(resolveLanguage('pt', ['it']).code).toBe('pt');
  expect(languages.map(language => language.code)).toEqual(languages.map(language => language.code).sort((a, b) => a.localeCompare(b)));
});
it('interpolates repeated values including zero, but never inherited values', () => {
  const language = resolveLanguage('en');
  expect(translate(language, '{count}/{count} {name}', { count: 0, name: '' })).toBe('0/0 ');
  expect(translate(language, '{toString} {missing}', Object.create({ missing: 'inherited' }))).toBe('{toString} {missing}');
});

it('uses browser preferences by default and handles environments without navigator', async () => {
  const { vi } = await import('vitest');
  try {
    vi.stubGlobal('navigator', { languages: ['it-IT', 'en'] });
    expect(resolveLanguage('auto').code).toBe('it');
    vi.stubGlobal('navigator', undefined);
    expect(resolveLanguage('auto').code).toBe('en');
  } finally { vi.unstubAllGlobals(); }
});
it('prefers an exact regional interface translation over the base language', async () => {
  const { interfaceLanguages } = await import('../src/locales/catalog');
  const contributed = { ...resolveLanguage('pt'), code: 'pt-BR' };
  interfaceLanguages.push(contributed);
  try { expect(resolveLanguage('PT-br').code).toBe('pt-BR'); }
  finally { interfaceLanguages.splice(interfaceLanguages.indexOf(contributed), 1); }
});
