// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/lib/settings';
import { prepareInput } from '../src/lib/prompts';
import { streamRemote, type RemoteProvider } from '../src/providers/remote';
import { article } from './fixtures';

const simulation = process.env.SMT_SIMULATION_URL || 'http://127.0.0.1:4318';
const providers: RemoteProvider[] = ['ollama', 'openai', 'anthropic', 'gemini'];
function run(provider: RemoteProvider, model = 'simulate-success', signal = new AbortController().signal) {
  const config = { ...defaultSettings().providers[provider], model, apiKey: 'fake-test-key' };
  let output = '';
  // Change only the HTTP destination; execute the real serialization, fetch,
  // cancellation, and parsing. Browser fetch doesn't honor HTTP_PROXY.
  const transport: typeof fetch = (url, init) => {
    const original = new URL(String(url));
    return fetch(`${simulation}/${provider}${original.pathname}${original.search}`, init);
  };
  return { result: streamRemote(provider, config, prepareInput(article, [], defaultSettings()), signal, text => { output += text; }, transport), output: () => output };
}
describe.each(providers)('%s over HTTP against Postman simulation', provider => {
  it('streams visible text, completes, and sends the source in the actual request', async () => {
    const call = run(provider);
    await call.result;
    expect(call.output()).toContain('Olá, 世界');
    expect(call.output()).not.toContain('INTERNAL_THOUGHT');
    const recorded = await fetch(`${simulation}/${provider}/_requests`).then(r => r.json());
    const request = recorded.requests.findLast((r: { model: string }) => r.model === 'simulate-success');
    expect(JSON.stringify(request.body)).toContain(article.text);
    expect(request.provider).toBe(provider);
  });
  it.each([
    ['simulate-auth', /API key/], ['simulate-quota', /rate or usage limit/], ['simulate-missing', /Model not found/],
    ['simulate-html', /HTTP 502/], ['simulate-malformed', /malformed/], ['simulate-error', /mid-stream/],
    ['simulate-empty', /no text/], ['simulate-drop', /before the answer was complete/], ['simulate-length', /output limit/],
  ])('reports %s accurately', async (scenario, expected) => {
    const call = run(provider, scenario as string);
    await expect(call.result).rejects.toThrow(expected as RegExp);
    if (scenario === 'simulate-drop' || scenario === 'simulate-length') expect(call.output()).toContain('clear takeaway');
    if (scenario === 'simulate-html') expect(call.output()).not.toContain('PRIVATE_SERVER_DATA');
  });
  it('cancels an in-flight HTTP request', async () => {
    const abort = new AbortController();
    const call = run(provider, 'simulate-slow', abort.signal);
    setTimeout(() => abort.abort(), 80);
    await expect(call.result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
it('reports Gemini safety blocking without pretending it is an empty success', async () => {
  await expect(run('gemini', 'simulate-blocked').result).rejects.toThrow('blocked this request');
});
