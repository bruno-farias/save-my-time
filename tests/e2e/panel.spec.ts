import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from './helpers';
import { articleHTML } from '../article-html';

test('preview supports a summary, follow-up, provider settings, and narrow panels', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173/sidepanel.html');
  await expect(page.getByText('Sample article & responses · no API calls')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The quiet case for doing less' })).toBeVisible();
  for (const width of [320, 390, 600]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/preview-welcome.png' });
  await page.getByRole('button', { name: 'Give me the short version' }).click();
  await expect(page.getByRole('button', { name: 'Copy answer' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Ask about this article' }).fill('What practical step should I take?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByRole('button', { name: 'Copy answer' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /OpenAI Connect/ }).click();
  await page.getByLabel('API key', { exact: true }).fill('  fake-preview-key  ');
  await page.getByLabel('Model', { exact: true }).selectOption('__custom__');
  await page.getByLabel('Model ID', { exact: true }).fill('  gpt-4.1-mini  ');
  const save = page.getByRole('button', { name: 'Save settings' });
  await expect(save).toBeDisabled();
  await page.getByLabel('New master password', { exact: true }).fill('test-only master password');
  await expect(save).toBeDisabled();
  await page.getByLabel('Confirm master password', { exact: true }).fill('a different master password');
  await expect(save).toBeDisabled();
  await expect(page.locator('#master-confirm-error')).toBeVisible();
  await page.getByLabel('Confirm master password', { exact: true }).fill('test-only master password');
  await expect(save).toBeEnabled();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('.model-switcher')).toContainText('OpenAI');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('fake-preview-key');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('gpt-4.1-mini');
  await page.getByRole('button', { name: 'Back to article' }).click();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByRole('heading', { name: /The big picture/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('built extension extracts a real tab, streams HTTP, keeps context, cancels, and isolates tabs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'save-my-time-e2e-'));
  const extensionDir = join(temp, 'extension');
  await cp(resolve('dist'), extensionDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  // Headless Chrome cannot click the native toolbar icon to grant activeTab.
  // Grant only the loopback fixture host in a temporary TEST COPY. The shipped
  // manifest remains activeTab-only for webpages.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url?.includes('second') ? articleHTML.replaceAll('A quieter way to work', 'A completely different article').replaceAll('Protect your attention', 'SECOND_ARTICLE_CONTEXT') : articleHTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind.');
  const fixtureURL = `http://127.0.0.1:${address.port}/first`;
  const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    ...(process.env.SMT_BROWSER_EXECUTABLE ? { executablePath: process.env.SMT_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport: { width: 390, height: 844 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    expect(await worker.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)).toBe(false);
    const settings = defaultSettings();
    settings.providers.ollama = { model: 'simulate-success', baseUrl: 'http://127.0.0.1:4320/ollama', apiKey: '' };
    await worker.evaluate(settings => chrome.storage.local.set({ settings }), settings);
    const articlePage = await context.newPage();
    await articlePage.goto(fixtureURL);
    const panel = await context.newPage();
    const errors: string[] = [];
    panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await articlePage.bringToFront();
    await expect(panel.getByRole('heading', { name: 'A quieter way to work' })).toBeVisible();
    const before = await fetch('http://127.0.0.1:4320/ollama/_requests').then(r => r.json());
    expect(before.requests).toHaveLength(0);
    await panel.screenshot({ path: 'test-results/extension-welcome.png' });
    await panel.getByRole('button', { name: 'Brief', exact: true }).click();
    await panel.getByLabel('Read in', { exact: true }).selectOption('pt');
    await panel.getByRole('button', { name: 'Give me the short version' }).click();
    await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveCount(1);
    await expect(panel.locator('.markdown')).toContainText('Olá, 世界');
    await panel.getByRole('textbox', { name: 'Ask about this article' }).fill('What is the evidence?');
    await panel.getByRole('button', { name: 'Send question' }).click();
    await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveCount(2);
    const calls = await fetch('http://127.0.0.1:4320/ollama/_requests').then(r => r.json());
    expect(calls.requests[0].body.messages[0].content).toContain('Português');
    expect(calls.requests[0].body.messages[1].content).toContain('about 60 words');
    expect(calls.requests[1].body.messages[1].content).toContain('Rest is part of the process');
    expect(calls.requests[1].body.messages.at(-1).content).toBe('What is the evidence?');
    expect(calls.requests[1].body.messages.some((m: { role: string; content: string }) => m.role === 'assistant' && m.content.includes('clear takeaway'))).toBe(true);
    await panel.screenshot({ path: 'test-results/extension-chat.png' });

    // Content scripts cannot read the local settings store, including API keys.
    const blocked = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: async () => {
        try { await chrome.storage.local.get('settings'); return false; } catch { return true; }
      } });
      return result[0].result;
    });
    expect(blocked).toBe(true);

    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByLabel('Model', { exact: true }).selectOption('__custom__');
    await panel.getByLabel('Model ID', { exact: true }).fill('simulate-slow');
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await panel.getByRole('button', { name: 'Make a new summary' }).click();
    await expect(panel.getByRole('button', { name: 'Stop generation' })).toBeVisible();
    await panel.getByRole('button', { name: 'Stop generation' }).click();
    await expect(panel.getByText('Stopped · incomplete')).toBeVisible();

    const secondPage = await context.newPage();
    await secondPage.goto(fixtureURL.replace('/first', '/second'));
    await secondPage.bringToFront();
    await expect(panel.getByRole('heading', { name: 'A completely different article' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveCount(0);
    await articlePage.bringToFront();
    await expect(panel.getByRole('heading', { name: 'A quieter way to work' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveCount(2);

    // A navigation during generation must abort and never attach stale output.
    await panel.getByRole('button', { name: 'Make a new summary' }).click();
    await expect(panel.getByRole('button', { name: 'Stop generation' })).toBeVisible();
    await articlePage.goto(fixtureURL.replace('/first', '/second'));
    await expect(panel.getByRole('heading', { name: 'A completely different article' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveCount(0);
    // A pending save after tab closure must not resurrect cached article data.
    const closingTabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id!);
    await panel.getByRole('button', { name: 'Give me the short version' }).click();
    await expect(panel.getByRole('button', { name: 'Stop generation' })).toBeVisible();
    await articlePage.close();
    await expect.poll(() => worker.evaluate(async id => (await chrome.storage.session.get(`article:${id}`))[`article:${id}`], closingTabId)).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
