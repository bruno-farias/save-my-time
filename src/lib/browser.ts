import { t } from './i18n';
import { providerOrigin } from './settings';
import { credentials } from './vault';
import type { Article, ArticleSession, ExtractionResult, Settings } from './types';

export const inExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
export const isPreview = import.meta.env.DEV && !inExtension;
let previewSession: ArticleSession | undefined;
let writeQueue: Promise<unknown> = Promise.resolve();

export async function loadSettings(): Promise<Settings> {
  return credentials.load();
}

export async function saveSettings(settings: Settings, updateKeys = false): Promise<Settings> {
  return credentials.save(settings, updateKeys);
}

// Called from a user gesture, without awaiting another operation first.
export async function requestProviderAccess(settings: Settings): Promise<void> {
  const origin = providerOrigin(settings.provider, settings.providers[settings.provider]);
  if (isPreview || !origin) return;
  if (!await chrome.permissions.request({ origins: [origin] })) throw new Error(t("Provider access was not granted. Save settings again to allow the connection."));
}

export async function hasProviderAccess(settings: Settings): Promise<boolean> {
  const origin = providerOrigin(settings.provider, settings.providers[settings.provider]);
  return isPreview || !origin || chrome.permissions.contains({ origins: [origin] });
}

export class PageAccessError extends Error {
  constructor() { super(t('Allow access to this page so Save My Time can read the article.')); }
}

// Keep the permission call in the button's user gesture. When activeTab has
// not been granted, Chrome can hide tab.url; request by tab ID in that case.
export async function requestPageAccess(tab: chrome.tabs.Tab): Promise<'granted' | 'requested' | 'toolbar'> {
  if (isPreview) return 'granted';
  if (tab.url && /^https?:\/\//i.test(tab.url)) {
    const url = new URL(tab.url);
    const origin = `${url.protocol}//${url.hostname}/*`;
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error(t("Site access was not granted. Allow access to read this article, or click the Save My Time toolbar icon."));
    return 'granted';
  }
  if (typeof chrome.permissions.addHostAccessRequest === 'function') {
    try {
      await chrome.permissions.addHostAccessRequest({ tabId: tab.id });
      return 'requested';
    } catch { /* Some Chromium browsers expose this API without supporting its UI. */ }
  }
  return 'toolbar';
}

export async function activeTab(): Promise<chrome.tabs.Tab> {
  if (isPreview) return { id: 1, windowId: 1, active: true, index: 0, pinned: false, highlighted: true, incognito: false, selected: true, discarded: false, autoDiscardable: true, frozen: false, lastAccessed: 0, groupId: -1, url: 'https://fieldnotes.example/the-case-for-doing-less', title: 'The quiet case for doing less' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error(t("Open an article in a browser tab, then click the extension icon."));
  return tab;
}

export async function readArticle(tabId: number): Promise<Article> {
  if (import.meta.env.DEV && isPreview) return (await import('../preview')).previewArticle;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
    const result = results[0]?.result as ExtractionResult | undefined;
    if (!result) throw new Error(t("No readable text was returned. Reload the article and try again."));
    if (!result.ok) throw new Error(t(result.error));
    return result.article;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/extensions gallery|chromewebstore\.google\.com|chrome\.google\.com\/webstore|(?:chrome|brave|edge|about|chrome-extension):/i.test(message)) throw new Error(t("This browser page cannot be read. Open an article on a website, then click the Save My Time toolbar icon. Browser settings, extension stores, and the built-in PDF viewer are protected."));
    if (/cannot access|permission|missing host|not allowed/i.test(message)) throw new PageAccessError();
    throw error;
  }
}

export async function loadSession(tabId: number, url: string): Promise<ArticleSession | undefined> {
  const key = `article:${tabId}`;
  const value = isPreview ? previewSession : (await chrome.storage.session.get(key))[key] as ArticleSession | undefined;
  if (!value || value.article?.url !== url || !Array.isArray(value.messages)) return undefined;
  return { ...value, messages: value.messages.map(m => m.status === 'streaming' ? { ...m, status: 'stopped' } : m) };
}

export function saveSession(tabId: number, session: ArticleSession): Promise<void> {
  const snapshot = structuredClone(session);
  snapshot.messages = snapshot.messages.slice(-40);
  while (snapshot.messages.length > 2 && new TextEncoder().encode(JSON.stringify(snapshot)).length > 700_000) snapshot.messages.splice(0, 2);
  if (isPreview) { previewSession = snapshot; return Promise.resolve(); }
  const write = async () => {
    const key = `article:${tabId}`;
    const stillCurrent = async () => {
      try { return (await chrome.tabs.get(tabId)).url === snapshot.article.url; }
      catch { return false; }
    };
    // An asynchronous save must not resurrect a closed tab or an old page
    // after the background worker cleared it during navigation.
    if (!await stillCurrent()) { await chrome.storage.session.remove(key); return; }
    const all = await chrome.storage.session.get(null);
    const older = Object.entries(all).filter(([k]) => k.startsWith('article:') && k !== key)
      .sort((a, b) => ((b[1] as ArticleSession).updatedAt || 0) - ((a[1] as ArticleSession).updatedAt || 0));
    if (older.length >= 8) await chrome.storage.session.remove(older.slice(7).map(([k]) => k));
    await chrome.storage.session.set({ [key]: snapshot });
    if (!await stillCurrent()) await chrome.storage.session.remove(key);
  };
  writeQueue = writeQueue.catch(() => {}).then(write);
  return writeQueue as Promise<void>;
}
