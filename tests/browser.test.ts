import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArticleSession, ChatMessage } from '../src/lib/types';
import { defaultSettings } from '../src/lib/settings';
import { article } from './fixtures';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
const message = (id: number, content = `message ${id}`): ChatMessage => ({ id: String(id), role: id % 2 ? 'assistant' : 'user', content, status: 'complete', kind: 'question' });
const session = (updatedAt = 1): ArticleSession => ({ article: { ...article }, messages: [message(0), message(1)], updatedAt });
function fixture(initial: Record<string, unknown> = {}) {
  const data = structuredClone(initial);
  const get = vi.fn(async (key: string | null) => structuredClone(key === null ? data : { [key]: data[key] }));
  const set = vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); });
  const remove = vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; });
  const tabs = { get: vi.fn(async () => ({ url: article.url })), query: vi.fn(async () => [{ id: 12, url: article.url }]) };
  const permissions = { request: vi.fn(async () => true), contains: vi.fn(async () => true), addHostAccessRequest: vi.fn(async () => {}) };
  const scripting = { executeScript: vi.fn(async () => [{ result: { ok: true, article } }]) };
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' }, tabs, permissions, scripting, storage: { session: { get, set, remove } } });
  return { data, get, set, remove, tabs, permissions, scripting };
}

describe('article sessions', () => {
  it.each([undefined, {}, { article }, { article, messages: {} }, { ...session(), article: { ...article, url: 'https://other.example' } }])('does not restore a missing, malformed, or different-page session: %j', async value => {
    fixture({ 'article:12': value });
    const { loadSession } = await import('../src/lib/browser');
    expect(await loadSession(12, article.url)).toBeUndefined();
  });
  it('marks interrupted streams stopped without changing completed or failed responses', async () => {
    const saved = session();
    saved.messages = ['streaming', 'complete', 'error', 'stopped'].map((status, index) => ({ ...message(index), status: status as ChatMessage['status'] }));
    const db = fixture({ 'article:12': saved });
    const { loadSession } = await import('../src/lib/browser');
    const loaded = await loadSession(12, article.url);
    expect(loaded?.messages.map(m => m.status)).toEqual(['stopped', 'complete', 'error', 'stopped']);
    expect(db.data['article:12']).toEqual(saved);
    expect(db.get).toHaveBeenCalledWith('article:12');
  });
  it('snapshots immediately, keeps the last 40 messages, and isolates tabs', async () => {
    const db = fixture({ 'article:13': session(2) });
    const { saveSession } = await import('../src/lib/browser');
    const original = session(); original.messages = Array.from({ length: 42 }, (_, i) => message(i));
    const saving = saveSession(12, original);
    original.article.title = 'changed after save'; original.messages[41].content = 'changed after save';
    await saving;
    const saved = db.data['article:12'] as ArticleSession;
    expect(saved.article.title).toBe(article.title);
    expect(saved.messages).toEqual(Array.from({ length: 40 }, (_, i) => message(i + 2)));
    expect(original.messages).toHaveLength(42);
    expect(db.data['article:13']).toEqual(session(2));
  });
  it('evicts the oldest article at the eight-article limit, preserving other session data', async () => {
    const saved = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`article:${i}`, session(i)]));
    const db = fixture({ ...saved, 'side-panel-window:1': 'panel-context' });
    const { saveSession } = await import('../src/lib/browser');
    await saveSession(12, session(10));
    expect(Object.keys(db.data).filter(key => key.startsWith('article:'))).toHaveLength(8);
    expect(db.data['article:0']).toBeUndefined();
    for (let i = 1; i < 8; i++) expect(db.data[`article:${i}`]).toEqual(session(i));
    expect(db.data['side-panel-window:1']).toBe('panel-context');
    await saveSession(7, session(11));
    expect(Object.keys(db.data).filter(key => key.startsWith('article:'))).toHaveLength(8);
    expect((db.data['article:7'] as ArticleSession).updatedAt).toBe(11);
  });
  it('trims old exchanges by UTF-8 size while retaining the newest pair', async () => {
    const db = fixture();
    const { saveSession } = await import('../src/lib/browser');
    const large = session();
    large.messages = [message(0, '文'.repeat(130_000)), message(1, '文'.repeat(130_000)), message(2), message(3)];
    await saveSession(12, large);
    expect((db.data['article:12'] as ArticleSession).messages).toEqual([message(2), message(3)]);
    expect(large.messages).toHaveLength(4);
  });
  it.each(['navigated', 'closed'])('cannot resurrect a session whose tab has %s', async state => {
    const db = fixture({ 'article:12': session() });
    if (state === 'closed') db.tabs.get.mockRejectedValue(new Error('Tab closed'));
    else db.tabs.get.mockResolvedValue({ url: 'https://other.example' });
    const { saveSession } = await import('../src/lib/browser');
    await saveSession(12, session());
    expect(db.data['article:12']).toBeUndefined(); expect(db.set).not.toHaveBeenCalled();
  });
  it('removes a write when navigation happens while it is being stored', async () => {
    const db = fixture();
    db.tabs.get.mockResolvedValueOnce({ url: article.url }).mockResolvedValueOnce({ url: 'https://other.example' });
    const { saveSession } = await import('../src/lib/browser');
    await saveSession(12, session());
    expect(db.set).toHaveBeenCalledOnce(); expect(db.data['article:12']).toBeUndefined();
  });
  it('serializes writes and recovers after a rejected storage operation', async () => {
    const db = fixture();
    db.set.mockRejectedValueOnce(new Error('Storage quota'));
    const { saveSession } = await import('../src/lib/browser');
    const failed = saveSession(12, session(1));
    const succeeded = saveSession(12, session(2));
    await expect(failed).rejects.toThrow('Storage quota'); await succeeded;
    expect(db.data['article:12']).toEqual(session(2));
    expect(db.set).toHaveBeenCalledTimes(2);
  });
});

describe('browser access boundaries', () => {
  it('resolves only the current window active tab and rejects a missing tab', async () => {
    const db = fixture();
    const { activeTab } = await import('../src/lib/browser');
    expect((await activeTab()).id).toBe(12);
    expect(db.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    db.tabs.query.mockResolvedValue([]);
    await expect(activeTab()).rejects.toThrow('Open an article');
  });
  it('returns the extracted article and reports missing or failed extraction', async () => {
    const db = fixture();
    const { readArticle } = await import('../src/lib/browser');
    expect(await readArticle(12)).toEqual(article);
    expect(db.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 12 }, files: ['extract.js'] });
    db.scripting.executeScript.mockResolvedValue([]);
    await expect(readArticle(12)).rejects.toThrow('No readable text');
    db.scripting.executeScript.mockResolvedValue([{ result: { ok: false, error: 'Extraction failed' } }] as never);
    await expect(readArticle(12)).rejects.toThrow('Extraction failed');
    const unexpected = new Error('Browser disconnected');
    db.scripting.executeScript.mockRejectedValue(unexpected);
    await expect(readArticle(12)).rejects.toBe(unexpected);
  });
  it('handles browsers exposing an unsupported permission-request API', async () => {
    const db = fixture(); db.permissions.addHostAccessRequest.mockRejectedValue(new Error('Not implemented'));
    const { requestPageAccess } = await import('../src/lib/browser');
    expect(await requestPageAccess({ id: 12 } as chrome.tabs.Tab)).toBe('toolbar');
  });
  it('requests the chosen provider within the gesture and rejects a denial', async () => {
    const db = fixture(); const settings = defaultSettings(); settings.provider = 'openai';
    const { requestProviderAccess, hasProviderAccess } = await import('../src/lib/browser');
    const granting = requestProviderAccess(settings);
    expect(db.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    await granting; expect(await hasProviderAccess(settings)).toBe(true);
    expect(db.permissions.contains).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    db.permissions.contains.mockResolvedValue(false); expect(await hasProviderAccess(settings)).toBe(false);
    db.permissions.request.mockResolvedValue(false);
    await expect(requestProviderAccess(settings)).rejects.toThrow('Provider access was not granted');
  });
  it('never requests a remote host for Chrome AI', async () => {
    const db = fixture(); const settings = defaultSettings(); settings.provider = 'chrome';
    const { requestProviderAccess, hasProviderAccess } = await import('../src/lib/browser');
    await requestProviderAccess(settings); expect(await hasProviderAccess(settings)).toBe(true);
    expect(db.permissions.request).not.toHaveBeenCalled(); expect(db.permissions.contains).not.toHaveBeenCalled();
  });
  it('delegates credential reads and edits to the vault', async () => {
    fixture();
    const { credentials } = await import('../src/lib/vault');
    const settings = defaultSettings();
    const load = vi.spyOn(credentials, 'load').mockResolvedValue(settings);
    const save = vi.spyOn(credentials, 'save').mockResolvedValue(settings);
    const { loadSettings, saveSettings } = await import('../src/lib/browser');
    expect(await loadSettings()).toBe(settings); expect(load).toHaveBeenCalledOnce();
    expect(await saveSettings(settings, true)).toBe(settings); expect(save).toHaveBeenLastCalledWith(settings, true);
    await saveSettings(settings); expect(save).toHaveBeenLastCalledWith(settings, false);
  });
  it('keeps preview interactions local without requesting Chrome permissions', async () => {
    vi.stubGlobal('chrome', undefined);
    const { activeTab, readArticle, requestPageAccess, requestProviderAccess, hasProviderAccess, saveSession, loadSession } = await import('../src/lib/browser');
    expect((await activeTab()).id).toBe(1);
    expect((await readArticle(1)).text.length).toBeGreaterThan(0);
    expect(await requestPageAccess({ id: 1 } as chrome.tabs.Tab)).toBe('granted');
    await requestProviderAccess(defaultSettings()); expect(await hasProviderAccess(defaultSettings())).toBe(true);
    await saveSession(1, session()); expect(await loadSession(1, article.url)).toEqual(session());
  });
});

it.each(['chrome://settings', 'brave://extensions', 'edge://settings', 'about:blank', 'chrome-extension://other/panel', 'Extensions gallery', 'chromewebstore.google.com', 'chrome.google.com/webstore'])('explains why protected browser content cannot be read: %s', async reason => {
  const db = fixture(); db.scripting.executeScript.mockRejectedValue(new Error(`Cannot access ${reason}`));
  const { readArticle } = await import('../src/lib/browser');
  await expect(readArticle(12)).rejects.toThrow('This browser page cannot be read');
});
it.each(['Cannot access the page', 'Permission missing', 'Missing host access', 'Not allowed'])('reports a permission problem for %s', async reason => {
  const db = fixture(); db.scripting.executeScript.mockRejectedValue(new Error(reason));
  const { readArticle, PageAccessError } = await import('../src/lib/browser');
  await expect(readArticle(12)).rejects.toBeInstanceOf(PageAccessError);
});
it('preserves non-Error rejection values instead of replacing them', async () => {
  const db = fixture(); db.scripting.executeScript.mockRejectedValue('disconnected');
  const { readArticle } = await import('../src/lib/browser');
  await expect(readArticle(12)).rejects.toBe('disconnected');
});
it('supports HTTP article permission requests and does not treat a non-web URL as a site origin', async () => {
  const db = fixture(); const { requestPageAccess } = await import('../src/lib/browser');
  expect(await requestPageAccess({ id: 12, url: 'http://article.example/story' } as chrome.tabs.Tab)).toBe('granted');
  expect(db.permissions.request).toHaveBeenLastCalledWith({ origins: ['http://article.example/*'] });
  db.permissions.request.mockClear();
  expect(await requestPageAccess({ id: 12, url: 'about:blank' } as chrome.tabs.Tab)).toBe('requested');
  expect(db.permissions.request).not.toHaveBeenCalled();
});
it('retains the newest exchange even when that pair exceeds the cache byte budget', async () => {
  const db = fixture(); const { saveSession } = await import('../src/lib/browser');
  const value = session(); value.messages = [message(0, 'x'.repeat(700001)), message(1)];
  await saveSession(12, value);
  expect((db.data['article:12'] as ArticleSession).messages).toEqual(value.messages);
});
it('evicts a legacy session with no timestamp before newer entries', async () => {
  const entries = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`article:${i}`, session(i + 1)]));
  entries['article:7'] = { ...session(), updatedAt: undefined } as unknown as ArticleSession;
  const db = fixture(entries); const { saveSession } = await import('../src/lib/browser');
  await saveSession(12, session(10));
  expect(db.data['article:7']).toBeUndefined(); expect(db.data['article:0']).toEqual(session(1));
});
