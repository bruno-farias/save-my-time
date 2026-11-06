import { describe, expect, it } from 'vitest';
import { defaultSettings, isLocalProvider, normalizeOllamaUrl, normalizeSettings, providerOrigin, validateProvider } from '../src/lib/settings';
import type { ProviderId } from '../src/lib/types';

const clouds = ['openai', 'anthropic', 'gemini'] as const;

describe('saved settings boundaries', () => {
  it.each([undefined, null, false, 42, 'settings', [], {}])('recovers defaults from %j', raw => {
    expect(normalizeSettings(raw)).toEqual(defaultSettings());
  });
  it('returns independent settings and provider objects on every call', () => {
    const first = defaultSettings();
    first.providers.openai.apiKey = 'fake-key'; first.providers.ollama.model = 'changed';
    expect(defaultSettings().providers.openai.apiKey).toBe('');
    expect(defaultSettings().providers.ollama.model).not.toBe('changed');
  });
  it('rejects unknown enums, inherited provider names, and output-only interface languages', () => {
    expect(normalizeSettings({ provider: '__proto__', length: 'huge', language: 'missing', uiLanguage: 'ar', theme: 'blue' })).toEqual(defaultSettings());
    expect(normalizeSettings({ provider: 'toString' })).toEqual(defaultSettings());
  });
  it.each(['ollama', 'chrome', ...clouds] as ProviderId[])('restores a selected %s provider and valid preferences', provider => {
    const saved = { ...defaultSettings(), provider, length: 'long', language: 'ar', uiLanguage: 'it', theme: 'light', vaultRevision: 'revision' };
    expect(normalizeSettings(saved)).toEqual(saved);
  });
  it.each(['short', 'medium', 'long'])('preserves the %s length choice', length => {
    expect(normalizeSettings({ length }).length).toBe(length);
  });
  it.each(['system', 'light', 'dark'])('preserves the %s theme choice', theme => {
    expect(normalizeSettings({ theme }).theme).toBe(theme);
  });
  it('trims and bounds model IDs, trims keys, and does not mutate input', () => {
    const raw = { providers: { openai: { model: `  ${'m'.repeat(161)}  `, apiKey: ' fake-key ' }, ollama: { model: ' local-model ', baseUrl: ' http://localhost:11434 ' } } };
    const result = normalizeSettings(raw);
    expect(result.providers.openai.model).toBe('m'.repeat(160));
    expect(result.providers.openai.apiKey).toBe('fake-key');
    expect(result.providers.ollama).toEqual({ model: 'local-model', baseUrl: 'http://localhost:11434', apiKey: '' });
    expect(raw.providers.openai.apiKey).toBe(' fake-key ');
    expect(normalizeSettings({ providers: { openai: { model: 'm'.repeat(160) } } }).providers.openai.model).toHaveLength(160);
  });
  it.each([null, false, 5, 'config', { model: 42, apiKey: false, baseUrl: {} }])('ignores malformed provider fields: %j', config => {
    expect(normalizeSettings({ vaultRevision: 3, providers: { ollama: config, openai: config } })).toEqual(defaultSettings());
  });
  it.each(clouds)('cannot redirect the %s API key through stored settings', provider => {
    const config = normalizeSettings({ providers: { [provider]: { baseUrl: 'https://attacker.example', apiKey: 'fake-key' } } }).providers[provider];
    expect(config.baseUrl).toBe(defaultSettings().providers[provider].baseUrl);
    expect(providerOrigin(provider, { ...config, baseUrl: 'https://attacker.example' })).toBe(`${config.baseUrl}/*`);
  });
});

describe('Ollama URLs and provider readiness', () => {
  it.each([
    [' http://localhost:11434/// ', 'http://localhost:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['http://[::1]:11434/', 'http://[::1]:11434'],
    ['https://models.example/proxy///', 'https://models.example/proxy'],
  ])('accepts %s', (input, normalized) => expect(normalizeOllamaUrl(input)).toBe(normalized));
  it.each(['', 'not a URL', 'ftp://localhost', 'file:///tmp/model', 'http://models.example', 'http://localhost.evil', 'https://user@example.com', 'https://:password@example.com', 'https://example.com?token=x', 'https://example.com#fragment'])('rejects %s', value => {
    expect(() => normalizeOllamaUrl(value)).toThrow();
  });
  it('requests only the configured server origin, with neither path nor port', () => {
    const config = { model: 'chat', apiKey: '', baseUrl: 'https://models.example:8443/proxy' };
    expect(providerOrigin('ollama', config)).toBe('https://models.example/*');
    expect(providerOrigin('chrome', config)).toBeNull();
  });
  it.each(clouds)('requires a model and key for %s', provider => {
    const config = { ...defaultSettings().providers[provider], apiKey: 'fake-key' };
    expect(() => validateProvider(provider, config)).not.toThrow();
    expect(() => validateProvider(provider, { ...config, model: ' ' })).toThrow('model');
    expect(() => validateProvider(provider, { ...config, apiKey: ' \n ' })).toThrow('API key');
  });
  it('allows browser AI without configuration and Ollama without a cloud key', () => {
    expect(() => validateProvider('chrome', { model: '', apiKey: '', baseUrl: '' })).not.toThrow();
    expect(() => validateProvider('ollama', defaultSettings().providers.ollama)).not.toThrow();
    expect(() => validateProvider('ollama', { ...defaultSettings().providers.ollama, baseUrl: 'http://remote.example' })).toThrow('HTTPS');
  });
  it.each(['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434'])('classifies %s as on-device', baseUrl => {
    expect(isLocalProvider('ollama', { model: 'chat', apiKey: '', baseUrl })).toBe(true);
  });
  it.each(['https://models.example', 'https://localhost.evil', 'not a URL'])('does not claim %s is on-device', baseUrl => {
    expect(isLocalProvider('ollama', { model: 'chat', apiKey: '', baseUrl })).toBe(false);
  });
  it('classifies browser AI and cloud providers independently of their stored URL', () => {
    const config = defaultSettings().providers.ollama;
    expect(isLocalProvider('chrome', config)).toBe(true);
    for (const provider of clouds) expect(isLocalProvider(provider, config)).toBe(false);
  });
});
