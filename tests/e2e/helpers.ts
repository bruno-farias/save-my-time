import { chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Settings } from '../../src/lib/types';
import { articleHTML } from '../article-html';

// Browser fixtures deliberately avoid importing Vite's runtime locale loader.
export function defaultSettings(): Settings {
  return {
    version: 1, provider: 'ollama', length: 'medium', language: 'auto', theme: 'system', uiLanguage: 'en',
    providers: {
      ollama: { model: 'simulate-success', baseUrl: 'http://127.0.0.1:4320/ollama', apiKey: '' },
      chrome: { model: 'Gemini Nano', baseUrl: '', apiKey: '' },
      openai: { model: 'simulate-success', baseUrl: 'https://api.openai.com', apiKey: '' },
      anthropic: { model: 'claude-fixture-new', baseUrl: 'https://api.anthropic.com', apiKey: '' },
      gemini: { model: 'gemini-fixture-new', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: '' },
    },
  };
}
export async function launchFixture(settings: Settings, configureExtension?: (directory: string) => Promise<void>) {
  const temp = await mkdtemp(join(tmpdir(), 'save-my-time-vault-')), extensionDir = join(temp, 'extension');
  await cp(resolve('dist'), extensionDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['https://read.example/*', 'http://127.0.0.1/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*'];
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  await configureExtension?.(extensionDir);
  const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    ...(process.env.SMT_BROWSER_EXECUTABLE ? { executablePath: process.env.SMT_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport: { width: 390, height: 844 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const calls: { provider: string; headers: Record<string, string>; body: string | null }[] = [], errors: string[] = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://read.example/**', route => route.fulfill({ contentType: 'text/html', body: articleHTML }));
  await context.route(/https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)\//, async route => {
    const url = new URL(route.request().url());
    const provider = url.hostname.includes('openai') ? 'openai' : url.hostname.includes('anthropic') ? 'anthropic' : 'gemini';
    calls.push({ provider, headers: route.request().headers(), body: route.request().postData() });
    try { const response = await route.fetch({ url: `http://127.0.0.1:4320/${provider}${url.pathname}${url.search}` }); await route.fulfill({ response }); }
    catch { await route.abort().catch(() => {}); }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(settings => chrome.storage.local.set({ settings }), settings);
  const article = await context.newPage(); await article.goto('https://read.example/article');
  const panelURL = `chrome-extension://${new URL(worker.url()).hostname}/sidepanel.html`;
  const panel = await context.newPage(); await panel.goto(panelURL); await article.bringToFront();
  return { context, worker, article, panel, panelURL, calls, errors, async close() { await context.close(); await rm(temp, { recursive: true, force: true }); } };
}
