import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSettings } from './helpers';
import { articleHTML } from '../article-html';

test('an API key does not mask missing article access; the panel offers an actionable permission flow', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'save-my-time-permission-'));
  const extensionDir = resolve('dist');
  const context = await chromium.launchPersistentContext(temp, {
    ...(process.env.SMT_BROWSER_EXECUTABLE ? { executablePath: process.env.SMT_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport: { width: 390, height: 844 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const remoteCalls: string[] = [];
  try {
    await context.route('https://read.example/**', route => route.fulfill({ contentType: 'text/html', body: articleHTML }));
    await context.route('https://api.openai.com/**', route => { remoteCalls.push(route.request().url()); return route.abort(); });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const settings = defaultSettings(); settings.provider = 'openai'; settings.providers.openai.apiKey = 'fake-test-key';
    await worker.evaluate(settings => chrome.storage.local.set({ settings }), settings);
    const article = await context.newPage(); await article.goto('https://read.example/article');
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`); await article.bringToFront();
    await panel.getByLabel('New master password', { exact: true }).fill('test-only master password');
    await panel.getByLabel('Confirm master password', { exact: true }).fill('test-only master password');
    await panel.getByRole('button', { name: 'Encrypt saved keys' }).click();
    const allow = panel.getByRole('button', { name: 'Allow access to this page', exact: true });
    await expect(allow).toBeEnabled();
    await expect(panel.getByRole('textbox', { name: 'Ask about this article' })).toBeDisabled();
    await allow.click();
    await expect(panel.getByRole('status').filter({ hasText: 'Save My Time toolbar icon' })).toBeVisible();
    await expect(allow).toBeEnabled();
    expect(remoteCalls).toEqual([]);
    expect(await worker.evaluate(async () => (await chrome.permissions.getAll()).origins || [])).toEqual([]);
    // Protected pages should not offer a permission that cannot be granted.
    await article.goto('chrome://settings');
    await expect(panel.getByText(/This browser page cannot be read/)).toBeVisible();
    await expect(allow).toHaveCount(0);
  } finally { await context.close(); await rm(temp, { recursive: true, force: true }); }
});

test('appearance follows the system, previews changes, and restores unsaved choices', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://127.0.0.1:4173/sidepanel.html');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Back to article' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/dark-welcome.png' });
  await page.getByRole('button', { name: 'Give me the short version' }).click();
  await expect(page.getByRole('button', { name: 'Copy answer' })).toBeVisible();
  await page.screenshot({ path: 'test-results/dark-chat.png' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('built settings discover all providers over HTTP, preserve custom models, reject stale catalogs, and persist dark mode', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'save-my-time-settings-'));
  const extensionDir = join(temp, 'extension');
  await cp(resolve('dist'), extensionDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  // Test profile only: all cloud requests below are routed to local Postman.
  manifest.host_permissions = ['https://read.example/*', 'http://127.0.0.1/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*'];
  await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    ...(process.env.SMT_BROWSER_EXECUTABLE ? { executablePath: process.env.SMT_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport: { width: 390, height: 844 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const calls: { provider: string; key: string }[] = [];
  const errors: string[] = [];
  try {
    await context.route('https://read.example/**', route => route.fulfill({ contentType: 'text/html', body: articleHTML }));
    await context.route(/https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)\//, async route => {
      const url = new URL(route.request().url());
      const provider = url.hostname.includes('openai') ? 'openai' : url.hostname.includes('anthropic') ? 'anthropic' : 'gemini';
      const headers = route.request().headers();
      calls.push({ provider, key: headers.authorization || headers['x-api-key'] || headers['x-goog-api-key'] });
      const response = await route.fetch({ url: `http://127.0.0.1:4320/${provider}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const settings = defaultSettings();
    settings.providers.ollama = { model: 'simulate-success', baseUrl: 'http://127.0.0.1:4320/ollama', apiKey: '' };
    await worker.evaluate(settings => chrome.storage.local.set({ settings }), settings);
    const article = await context.newPage(); await article.goto('https://read.example/article');
    const panel = await context.newPage(); panel.on('pageerror', error => errors.push(error.message));
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`); await article.bringToFront();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('2 installed models found.');
    await panel.getByLabel('Model', { exact: true }).selectOption('simulate-slow');
    await panel.getByRole('button', { name: /OpenAI Connect/ }).click();
    await expect(panel.getByRole('button', { name: 'Load models', exact: true })).toBeDisabled();
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key');
    await expect(panel.getByRole('status')).toHaveText('3 available models found.');
    await panel.getByLabel('Model', { exact: true }).selectOption('gpt-fixture-chat');
    await panel.getByRole('button', { name: 'Refresh models' }).click();
    await expect(panel.getByRole('status')).toHaveText('3 available models found.');
    await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('gpt-fixture-chat');
    await panel.getByRole('button', { name: /Claude Connect/ }).click();
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key');
    await expect(panel.getByRole('status')).toHaveText('2 available models found.');
    await panel.getByLabel('Model', { exact: true }).selectOption('claude-fixture-older');
    await panel.getByRole('button', { name: /Gemini Connect/ }).click();
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key');
    await expect(panel.getByRole('status')).toHaveText('2 available models found.');
    await panel.getByLabel('Model', { exact: true }).selectOption('gemini-fixture-older');
    await panel.getByRole('button', { name: /OpenAI Connect/ }).click();
    await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('gpt-fixture-chat');
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key-slow');
    await expect.poll(() => calls.some(call => call.key === 'Bearer fake-test-key-slow')).toBe(true);
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key-alternate');
    await expect(panel.getByRole('status')).toHaveText('1 available model found.');
    await expect(panel.locator('#model option')).toHaveText(['gpt-fixture-chat (current)', 'gpt-fixture-alternate', 'Enter model manually…']);
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key-auth');
    await expect(panel.getByRole('alert')).toContainText('rejected the API key');
    await panel.getByLabel('Model', { exact: true }).selectOption('__custom__');
    await panel.getByLabel('Model ID').fill('my-custom-model');
    await panel.getByLabel('API key', { exact: true }).fill('fake-test-key');
    await expect(panel.getByRole('status')).toHaveText('3 available models found.');
    await expect(panel.getByLabel('Model ID')).toHaveValue('my-custom-model');
    await panel.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark');
    for (const width of [320, 390, 600]) {
      await panel.setViewportSize({ width, height: 844 });
      expect(await panel.evaluate(() => [...document.querySelectorAll('input, select, button')].every(el => el.getBoundingClientRect().right <= innerWidth))).toBe(true);
    }
    await panel.setViewportSize({ width: 390, height: 1100 });
    await panel.locator('.settings-screen').evaluate(el => { el.scrollTop = 0; });
    await panel.screenshot({ path: 'test-results/dark-settings.png', animations: 'disabled' });
    await panel.getByLabel('New master password', { exact: true }).fill('test-only master password');
    await panel.getByLabel('Confirm master password', { exact: true }).fill('test-only master password');
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await panel.reload(); await article.bringToFront();
    await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark');
    await panel.getByLabel('Master password', { exact: true }).fill('test-only master password');
    await panel.getByRole('button', { name: 'Unlock vault' }).click();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('my-custom-model');
    await expect(panel.getByLabel('API key', { exact: true })).toHaveValue('fake-test-key');
    await expect(panel.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(calls.some(call => call.provider === 'anthropic')).toBe(true);
    expect(calls.some(call => call.provider === 'gemini')).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); await rm(temp, { recursive: true, force: true }); }
});
