import { t } from '../lib/i18n';
import { normalizeOllamaUrl, PROVIDERS, validateProvider } from '../lib/settings';
import { readLines, readSSE } from '../lib/streams';
import type { GenerationInput, ProviderConfig, ProviderId } from '../lib/types';

export type RemoteProvider = Exclude<ProviderId, 'chrome'>;

export function buildRequest(provider: RemoteProvider, config: ProviderConfig, input: GenerationInput): { url: string; init: RequestInit } {
  validateProvider(provider, config);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const messages = [{ role: 'system', content: input.system }, ...input.turns];
  let url: string;
  let body: object;
  if (provider === 'ollama') {
    url = `${normalizeOllamaUrl(config.baseUrl)}/api/chat`;
    body = { model: config.model, messages, stream: true, options: { num_ctx: 16_384, num_predict: 2_048 } };
  } else if (provider === 'openai') {
    url = `${PROVIDERS.openai.baseUrl}/v1/chat/completions`;
    headers.Authorization = `Bearer ${config.apiKey}`;
    body = { model: config.model, messages, stream: true, max_completion_tokens: 4_096, store: false };
  } else if (provider === 'anthropic') {
    url = `${PROVIDERS.anthropic.baseUrl}/v1/messages`;
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = { model: config.model, system: input.system, messages: input.turns, max_tokens: 4_096, stream: true };
  } else {
    url = `${PROVIDERS.gemini.baseUrl}/v1beta/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`;
    headers['x-goog-api-key'] = config.apiKey;
    body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: input.turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
      generationConfig: { maxOutputTokens: 8_192 },
    };
  }
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store' } };
}

interface StreamEvent {
  type?: string;
  error?: string | { message?: string; type?: string };
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  choices?: { delta?: { content?: string; refusal?: string }; finish_reason?: string | null }[];
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

function providerError(event: StreamEvent): string | undefined {
  if (typeof event.error === 'string') return event.error;
  return event.error?.message;
}

function safeDetail(message: string, apiKey: string): string {
  return (apiKey ? message.split(apiKey).join('[redacted]') : message).slice(0, 320);
}

async function httpError(response: Response, provider: RemoteProvider, apiKey: string): Promise<Error> {
  const name = PROVIDERS[provider].name;
  if (response.status === 401) return new Error(t('{provider} rejected the API key. Check it in settings.', { provider: name }));
  if (response.status === 403 && provider === 'ollama') return new Error(t("Ollama blocked the extension. Allow this extension’s origin with OLLAMA_ORIGINS and restart Ollama. See the setup instructions in settings."));
  if (response.status === 403) return new Error(t('{provider} denied access. Check the key’s permissions and account access.', { provider: name }));
  if (response.status === 429) return new Error(t('{provider} reached a rate or usage limit. Check your quota and try again later.', { provider: name }));
  let detail = '';
  try { detail = providerError(await response.json() as StreamEvent) || ''; } catch { /* An HTML gateway response is not user-facing content. */ }
  return new Error(t('{provider} returned HTTP {status}. {detail}', { provider: name, status: response.status, detail: detail ? safeDetail(detail, apiKey) : t('Check the model name and try again.') }));
}

export async function streamRemote(
  provider: RemoteProvider,
  config: ProviderConfig,
  input: GenerationInput,
  signal: AbortSignal,
  onDelta: (text: string) => void,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const request = buildRequest(provider, config, input);
  const response = await fetcher(request.url, { ...request.init, signal });
  if (!response.ok) throw await httpError(response, provider, config.apiKey);
  if (!response.body) throw new Error(t("The provider returned an empty response."));
  const records = provider === 'ollama' ? readLines(response.body) : readSSE(response.body);
  let finished = false;
  let received = 0;
  for await (const record of records) {
    signal.throwIfAborted();
    if (!record.trim()) continue;
    if (record === '[DONE]' && provider === 'openai') { finished = true; break; }
    let event: StreamEvent;
    try { event = JSON.parse(record) as StreamEvent; }
    catch { throw new Error(t("The provider sent a malformed response. Please try again.")); }
    if (!event || typeof event !== 'object') throw new Error(t("The provider sent an invalid response."));
    if (event.error || event.type === 'error') throw new Error(safeDetail(providerError(event) || t('The provider interrupted the response.'), config.apiKey));

    let text = '';
    let finishReason: string | null | undefined;
    if (provider === 'ollama') {
      text = event.message?.content || '';
      finished = event.done === true;
      finishReason = event.done_reason;
    } else if (provider === 'openai') {
      const choice = event.choices?.[0];
      if (choice?.delta?.refusal) throw new Error(t("The model declined this request. Try a different question."));
      text = choice?.delta?.content || '';
      finishReason = choice?.finish_reason;
    } else if (provider === 'anthropic') {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text = event.delta.text || '';
      finished = event.type === 'message_stop';
      finishReason = event.delta?.stop_reason;
    } else {
      if (event.promptFeedback?.blockReason) throw new Error(t('Gemini blocked this request ({reason}). Try a different question.', { reason: safeDetail(event.promptFeedback.blockReason, config.apiKey) }));
      const candidate = event.candidates?.[0];
      text = candidate?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
      finishReason = candidate?.finishReason;
      if (finishReason === 'STOP') finished = true;
      else if (finishReason && finishReason !== 'MAX_TOKENS') throw new Error(t('Gemini stopped this response ({reason}). The answer is incomplete.', { reason: safeDetail(finishReason, config.apiKey) }));
    }
    if (typeof text !== 'string') throw new Error(t("The provider returned unexpected text data."));
    if (text) {
      received += text.length;
      if (received > 60_000) throw new Error(t("The response exceeded the reading limit. Ask for a shorter answer."));
      onDelta(text);
    }
    if (['length', 'max_tokens', 'MAX_TOKENS'].includes(finishReason || '')) throw new Error(t("The model reached its output limit. This answer is incomplete; try a shorter summary or another model."));
    if (['content_filter', 'refusal'].includes(finishReason || '')) throw new Error(t("The provider filtered this response. The answer is incomplete."));
    if (finished) break;
  }
  signal.throwIfAborted();
  if (!finished) throw new Error(t("The connection ended before the answer was complete. Please try again."));
  if (!received) throw new Error(t("The model returned no text. Try another model or a shorter article."));
}
