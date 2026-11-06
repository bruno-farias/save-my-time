import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('requests only the visible article site, preserving the button gesture', async () => {
  const request = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' }, permissions: { request } });
  const { requestPageAccess } = await import('../src/lib/browser');
  const pending = requestPageAccess({ id: 12, url: 'https://article.example:8443/story?private=value' } as chrome.tabs.Tab);
  // Request must run synchronously before any other await loses user activation.
  expect(request).toHaveBeenCalledWith({ origins: ['https://article.example/*'] });
  expect(await pending).toBe('granted');
});

it('can request the article tab when the browser hides its URL before permission', async () => {
  const addHostAccessRequest = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' }, permissions: { addHostAccessRequest } });
  const { requestPageAccess } = await import('../src/lib/browser');
  expect(await requestPageAccess({ id: 12 } as chrome.tabs.Tab)).toBe('requested');
  expect(addHostAccessRequest).toHaveBeenCalledWith({ tabId: 12 });
});

it('offers the toolbar fallback on browsers without the host request API', async () => {
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' }, permissions: {} });
  const { requestPageAccess } = await import('../src/lib/browser');
  expect(await requestPageAccess({ id: 12 } as chrome.tabs.Tab)).toBe('toolbar');
});

it('keeps a declined site request blocked', async () => {
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' }, permissions: { request: vi.fn().mockResolvedValue(false) } });
  const { requestPageAccess } = await import('../src/lib/browser');
  await expect(requestPageAccess({ id: 12, url: 'https://article.example/' } as chrome.tabs.Tab)).rejects.toThrow('Site access was not granted');
});

it('distinguishes a missing page grant from a protected browser page', async () => {
  const executeScript = vi.fn().mockRejectedValue(new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'));
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension' }, scripting: { executeScript } });
  const { readArticle, PageAccessError } = await import('../src/lib/browser');
  await expect(readArticle(12)).rejects.toBeInstanceOf(PageAccessError);
  executeScript.mockRejectedValue(new Error('Cannot access a chrome:// URL'));
  await expect(readArticle(12)).rejects.toThrow('This browser page cannot be read');
});
