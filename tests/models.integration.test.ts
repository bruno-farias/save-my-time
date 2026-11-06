// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/lib/settings';
import { listModels } from '../src/providers/models';
import type { RemoteProvider } from '../src/providers/remote';

const simulation = process.env.SMT_SIMULATION_URL || 'http://127.0.0.1:4318';
const providers: RemoteProvider[] = ['ollama', 'openai', 'anthropic', 'gemini'];
function run(provider: RemoteProvider, scenario = 'success', signal = new AbortController().signal) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const config = { ...defaultSettings().providers[provider], apiKey: '  fake-test-key  ' };
  if (provider !== 'ollama') config.baseUrl = 'https://untrusted.example';
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input)); requests.push({ url, init });
    // Exercise the actual HTTP client against the Postman member routes.
    return fetch(`${simulation}/${provider}${url.pathname}${url.search}`, { ...init, headers: { ...init?.headers, 'x-fixture-scenario': scenario } });
  };
  return { result: listModels(provider, config, signal, transport), requests };
}

describe.each(providers)('%s model discovery over HTTP', provider => {
  it('authenticates, follows pagination, filters non-text models, and keeps unique model IDs', async () => {
    const call = run(provider);
    const models = await call.result;
    const ids = models.map(model => model.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => !/embedding|transcribe|dall-e|^models\//.test(id))).toBe(true);
    if (provider === 'anthropic' || provider === 'gemini') {
      expect(call.requests).toHaveLength(2);
      expect(models.some(model => model.name.includes('Older'))).toBe(true);
      expect(call.requests[1].url.searchParams.get(provider === 'anthropic' ? 'after_id' : 'pageToken')).toBe(provider === 'anthropic' ? 'claude-fixture-new' : 'opaque/token+=1');
    }
    const request = call.requests[0];
    expect(request.url.hostname).not.toBe('untrusted.example');
    expect(request.url.toString()).not.toContain('fake-test-key');
    expect(request.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    if (provider === 'ollama') expect(request.init?.headers).not.toHaveProperty('Authorization');
  });
  it.each([
    ['auth', /API key/], ['forbidden', /access|permissions/], ['quota', /rate or usage limit/],
    ['html', /HTTP 502/], ['invalid', /invalid model list/], ['redirect', /Could not connect/],
  ])('reports %s without exposing upstream bodies or keys', async (scenario, pattern) => {
    const message = await run(provider, scenario as string).result.catch(cause => (cause as Error).message);
    expect(message).toMatch(pattern as RegExp);
    expect(message).not.toMatch(/PRIVATE_|fake-test-key/);
  });
  it('returns an empty catalog without inventing available models', async () => {
    expect(await run(provider, 'empty').result).toEqual([]);
  });
  it('cancels the pending fetch when credentials change or the panel closes', async () => {
    const abort = new AbortController();
    const call = run(provider, 'slow', abort.signal);
    setTimeout(() => abort.abort(), 60);
    await expect(call.result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
it.each(['anthropic', 'gemini'] as const)('stops a repeated %s pagination cursor', async provider => {
  await expect(run(provider, 'repeat').result).rejects.toThrow('repeated a model-list page');
});
