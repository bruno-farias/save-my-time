import { t } from '../lib/i18n';
import { normalizeOllamaUrl, PROVIDERS } from '../lib/settings';
import type { ProviderConfig, ProviderId } from '../lib/types';

export interface ModelOption { id: string; name: string }
type ModelProvider = Exclude<ProviderId, 'chrome'>;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

// OpenAI does not return endpoint capabilities. Exclude recognizable non-chat
// families; keep unknown/new IDs and manual entry rather than a frozen allowlist.
function chatCandidate(id: string) {
  return !/(?:^|[-:])(?:embedding|embeddings|moderation|whisper|tts|transcribe|realtime|audio|image|dall-e|sora)(?:[-:]|$)/i.test(id)
    && !/^(?:(?:babbage|davinci|curie|ada)(?:[-:]|$)|text-)/i.test(id);
}

export async function listModels(provider: ModelProvider, config: ProviderConfig, signal: AbortSignal, transport: typeof fetch = fetch): Promise<ModelOption[]> {
  const base = provider === 'ollama' ? normalizeOllamaUrl(config.baseUrl) : PROVIDERS[provider].baseUrl;
  const key = config.apiKey.trim();
  if (provider !== 'ollama' && !key) throw new Error(t('Add your {provider} API key to load models.', { provider: PROVIDERS[provider].name }));
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider === 'openai') headers.Authorization = `Bearer ${key}`;
  if (provider === 'anthropic') Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  if (provider === 'gemini') headers['x-goog-api-key'] = key;
  const url = new URL(`${base}${provider === 'ollama' ? '/api/tags' : provider === 'gemini' ? '/v1beta/models' : '/v1/models'}`);
  if (provider === 'anthropic') url.searchParams.set('limit', '1000');
  if (provider === 'gemini') url.searchParams.set('pageSize', '1000');
  const models = new Map<string, ModelOption>();
  const cursors = new Set<string>();
  try {
    for (let page = 0; page < 100; page++) {
      signal.throwIfAborted();
      const response = await transport(url.toString(), { headers, signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) {
        // Don't render upstream bodies, which can echo credentials or HTML.
        const name = PROVIDERS[provider].name;
        if (response.status === 401) throw new Error(t('{provider} rejected the API key. Check it and try again.', { provider: name }));
        if (response.status === 403) throw new Error(provider === 'ollama' ? t('Ollama denied access. Check OLLAMA_ORIGINS in the setup guide.') : t('{provider} denied model-list access. Check your API key permissions. You can still enter a model manually.', { provider: name }));
        if (response.status === 429) throw new Error(t('{provider} reached a rate or usage limit. Wait a moment and refresh the models.', { provider: name }));
        throw new Error(t('{provider} could not list models (HTTP {status}). You can still enter a model manually.', { provider: name, status: response.status }));
      }
      let body: JsonObject;
      try { body = object(await response.json()); }
      catch (cause) { signal.throwIfAborted(); throw new Error(t('{provider} returned an invalid model list.', { provider: PROVIDERS[provider].name }), { cause }); }
      const entries = provider === 'ollama' || provider === 'gemini' ? body.models : body.data;
      // Google protobuf JSON can omit an empty repeated field.
      if (!Array.isArray(entries) && !(provider === 'gemini' && entries === undefined && !body.error)) throw new Error(t('{provider} returned an invalid model list.', { provider: PROVIDERS[provider].name }));
      for (const value of (entries || []) as unknown[]) {
        const entry = object(value);
        const rawId = provider === 'ollama' || provider === 'gemini' ? entry.name : entry.id;
        if (typeof rawId !== 'string' || !rawId.trim()) continue;
        const id = provider === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
        if (provider === 'gemini' && (!Array.isArray(entry.supportedGenerationMethods) || !entry.supportedGenerationMethods.includes('generateContent'))) continue;
        if (provider === 'openai' && !chatCandidate(id)) continue;
        const name = provider === 'anthropic' ? entry.display_name : provider === 'gemini' ? entry.displayName : id;
        models.set(id, { id, name: typeof name === 'string' && name ? name : id });
      }
      const cursor = provider === 'anthropic' && body.has_more ? body.last_id : provider === 'gemini' ? body.nextPageToken : undefined;
      if (provider === 'anthropic' && body.has_more && !cursor) throw new Error(t("Claude returned an incomplete model list. Try refreshing it."));
      if (!cursor) return [...models.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error(t("The provider repeated a model-list page. Try refreshing it."));
      cursors.add(cursor);
      // Follow opaque cursor values, never an upstream URL.
      url.searchParams.set(provider === 'anthropic' ? 'after_id' : 'pageToken', cursor);
    }
    throw new Error(t("The model list is too large to load completely. Enter a model manually."));
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof TypeError) throw new Error(provider === 'ollama' ? t('Could not connect to Ollama. Check the server address and OLLAMA_ORIGINS in the setup guide.') : t('Could not connect to {provider}. Check your connection and browser access, then refresh the models.', { provider: PROVIDERS[provider].name }));
    throw cause;
  }
}
