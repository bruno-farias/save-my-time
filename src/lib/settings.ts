import { t, mark } from './i18n';
import type { ProviderConfig, ProviderId, Settings, SummaryLength } from './types';
import { interfaceLanguages, languages } from '../locales/catalog';

export const PROVIDERS: Record<ProviderId, { name: string; detail: string; local: boolean; model: string; baseUrl: string }> = {
  ollama: { name: 'Ollama', detail: mark('Your own local models'), local: true, model: 'llama3.2', baseUrl: 'http://localhost:11434' },
  chrome: { name: 'Chrome AI', detail: mark('Built into your browser'), local: true, model: 'Gemini Nano', baseUrl: '' },
  openai: { name: 'OpenAI', detail: mark('Connect with your API key'), local: false, model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com' },
  anthropic: { name: 'Claude', detail: mark('Connect with your API key'), local: false, model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' },
  gemini: { name: 'Gemini', detail: mark('Connect with your API key'), local: false, model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
};

export const LANGUAGES: [string, string][] = [['auto', 'Same as article'], ...languages.map(language => [language.code, language.nativeName] as [string, string])];

export const LENGTHS: { id: SummaryLength; label: string; detail: string }[] = [
  { id: 'short', label: mark('Brief'), detail: 'The essentials · ~60 words' },
  { id: 'medium', label: mark('Balanced'), detail: 'The big picture · ~150 words' },
  { id: 'long', label: mark('Detailed'), detail: 'A closer look · ~300 words' },
];

export function defaultSettings(): Settings {
  return {
    version: 1, provider: 'ollama', length: 'medium', language: 'auto', theme: 'system', uiLanguage: 'auto',
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { model: p.model, baseUrl: p.baseUrl, apiKey: '' }])) as Settings['providers'],
  };
}

export function normalizeSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (!raw || typeof raw !== 'object') return defaults;
  const saved = raw as Partial<Settings>;
  if (saved.provider && Object.hasOwn(PROVIDERS, saved.provider)) defaults.provider = saved.provider;
  if (LENGTHS.some(l => l.id === saved.length)) defaults.length = saved.length!;
  if (LANGUAGES.some(l => l[0] === saved.language)) defaults.language = saved.language!;
  if (saved.theme && ['system', 'light', 'dark'].includes(saved.theme)) defaults.theme = saved.theme;
  if (saved.uiLanguage === 'auto' || interfaceLanguages.some(language => language.code === saved.uiLanguage)) defaults.uiLanguage = saved.uiLanguage!;
  if (typeof saved.vaultRevision === 'string') defaults.vaultRevision = saved.vaultRevision;
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    const p = saved.providers?.[id];
    if (!p || typeof p !== 'object') continue;
    defaults.providers[id].model = typeof p.model === 'string' ? p.model.trim().slice(0, 160) : PROVIDERS[id].model;
    defaults.providers[id].apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
    // Saved data cannot redirect a cloud provider's API key.
    if (id === 'ollama' && typeof p.baseUrl === 'string') defaults.providers[id].baseUrl = p.baseUrl.trim();
  }
  return defaults;
}

export function normalizeOllamaUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(t("Enter a full Ollama URL, such as http://localhost:11434.")); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(t("Use an HTTP or HTTPS server URL without credentials, a query, or a fragment."));
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw new Error(t("Use HTTPS for a remote Ollama server. HTTP is allowed only on this device."));
  return url.href.replace(/\/+$/, '');
}

export function validateProvider(provider: ProviderId, config: ProviderConfig): void {
  if (provider === 'chrome') return;
  if (!config.model.trim()) throw new Error(t("Enter a model name in settings."));
  if (provider === 'ollama') normalizeOllamaUrl(config.baseUrl);
  else if (!config.apiKey.trim()) throw new Error(t('Add your {provider} API key in settings first.', { provider: PROVIDERS[provider].name }));
}

export function providerOrigin(provider: ProviderId, config: ProviderConfig): string | null {
  if (provider === 'chrome') return null;
  const base = provider === 'ollama' ? normalizeOllamaUrl(config.baseUrl) : PROVIDERS[provider].baseUrl;
  const url = new URL(base);
  // Chrome match patterns do not include a port.
  return `${url.protocol}//${url.hostname}/*`;
}

export function isLocalProvider(provider: ProviderId, config: ProviderConfig): boolean {
  if (provider === 'chrome') return true;
  if (provider !== 'ollama') return false;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname); } catch { return false; }
}
