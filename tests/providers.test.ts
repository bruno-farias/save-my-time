import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeOllamaUrl, normalizeSettings, providerOrigin } from '../src/lib/settings';
import { buildRequest } from '../src/providers/remote';
import { input } from './fixtures';

describe('provider contracts and credential boundaries', () => {
  it('never lets saved cloud settings redirect credentials', () => {
    const saved = defaultSettings();
    saved.providers.openai.baseUrl = 'https://attacker.invalid';
    saved.providers.openai.apiKey = 'test-key';
    expect(normalizeSettings(saved).providers.openai.baseUrl).toBe('https://api.openai.com');
    const request = buildRequest('openai', saved.providers.openai, input());
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request.init.credentials).toBe('omit');
    expect(request.init.redirect).toBe('error');
  });
  it('uses the correct auth, payload, and role mapping for each provider', () => {
    const settings = defaultSettings();
    for (const provider of ['openai', 'anthropic', 'gemini'] as const) settings.providers[provider].apiKey = 'fake-test-key';
    const openai = buildRequest('openai', settings.providers.openai, input());
    expect(openai.init.headers).toHaveProperty('Authorization', 'Bearer fake-test-key');
    expect(JSON.parse(openai.init.body as string).store).toBe(false);
    const claude = buildRequest('anthropic', settings.providers.anthropic, input());
    expect(claude.init.headers).toHaveProperty('anthropic-version', '2023-06-01');
    const claudeBody = JSON.parse(claude.init.body as string);
    expect(claudeBody.system).toContain('article');
    expect(claudeBody.messages[0].role).toBe('user');
    expect(claudeBody.max_tokens).toBeGreaterThan(0);
    settings.providers.gemini.model = 'models/gemini-3.8-flash';
    const gemini = buildRequest('gemini', settings.providers.gemini, { ...input(), turns: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'Q2' }] });
    expect(gemini.url).toContain('/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(gemini.url).not.toContain('fake-test-key');
    expect(gemini.init.headers).toHaveProperty('x-goog-api-key', 'fake-test-key');
    expect(JSON.parse(gemini.init.body as string).contents[1].role).toBe('model');
    expect(JSON.parse(buildRequest('ollama', settings.providers.ollama, input()).init.body as string).options.num_ctx).toBe(16_384);
  });
  it('accepts loopback and HTTPS Ollama URLs, rejecting unsafe URLs', () => {
    expect(normalizeOllamaUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeOllamaUrl('https://ollama.example.test/proxy/')).toBe('https://ollama.example.test/proxy');
    for (const url of ['file:///tmp/key', 'http://192.168.1.3:11434', 'https://user:pass@example.com', 'https://example.com?key=secret', 'http://localhost.evil:11434']) expect(() => normalizeOllamaUrl(url)).toThrow();
    expect(providerOrigin('ollama', defaultSettings().providers.ollama)).toBe('http://localhost/*');
  });
});
