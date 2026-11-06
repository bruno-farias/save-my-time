import { test, expect, type Page } from '@playwright/test';
import { defaultSettings, launchFixture } from './helpers';
import type { StoredSettings } from '../../src/lib/credential-store';
import type { Settings, ArticleSession } from '../../src/lib/types';
const password = 'test-only master password';
const changedPassword = 'changed test-only password';
async function setup(panel: Page) {
  await panel.getByLabel('New master password', { exact: true }).fill(password);
  await panel.getByLabel('Confirm master password', { exact: true }).fill(password);
  await panel.getByRole('button', { name: 'Encrypt saved keys' }).click();
  await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}
async function unlock(panel: Page, value = password) {
  await panel.getByLabel('Master password', { exact: true }).fill(value);
  await panel.getByRole('button', { name: 'Unlock vault' }).click();
}
function legacy() { const settings = defaultSettings(); settings.provider = 'openai'; settings.theme = 'dark'; for (const id of ['openai', 'anthropic', 'gemini'] as const) settings.providers[id].apiKey = 'fake-test-key'; return settings; }

test('migrates old keys, uses them for HTTP, rotates passwords across panels, and resets only credentials', async () => {
  const fixture = await launchFixture(legacy()); const { panel, worker, context, article, panelURL, calls, errors } = fixture;
  try {
    await expect(panel.getByRole('heading', { name: 'Protect your saved keys' })).toBeVisible();
    await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark'); expect(calls).toHaveLength(0);
    const encrypt = panel.getByRole('button', { name: 'Encrypt saved keys' });
    const newPassword = panel.getByLabel('New master password', { exact: true });
    const confirmation = panel.getByLabel('Confirm master password', { exact: true });
    await expect(encrypt).toBeDisabled();
    await newPassword.fill('12345678901');
    await confirmation.fill('12345678901');
    await expect(encrypt).toBeDisabled();
    await expect(panel.locator('#master-new-error')).toContainText('12 characters');
    await newPassword.fill('123456789012');
    await confirmation.fill('123456789012');
    await expect(encrypt).toBeEnabled();
    await confirmation.fill('');
    await expect(encrypt).toBeDisabled();
    await panel.getByLabel('New master password', { exact: true }).fill(password);
    await panel.getByLabel('Confirm master password', { exact: true }).fill(changedPassword);
    await expect(encrypt).toBeDisabled();
    await expect(panel.locator('#master-confirm-error')).toHaveText('The master passwords do not match.');
    await expect(confirmation).toHaveAttribute('aria-invalid', 'true');
    // Submission must remain protected even if a script bypasses the button.
    await panel.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit());
    await expect(panel.getByRole('alert')).toContainText('do not match');
    expect(await worker.evaluate(async () => (await chrome.storage.local.get<{ settings: Settings }>('settings')).settings.providers.openai.apiKey)).toBe('fake-test-key');
    await confirmation.fill(password);
    await expect(encrypt).toBeEnabled();
    await expect(panel.locator('#master-confirm-error')).toHaveCount(0);
    await newPassword.fill(`${password} `);
    await expect(encrypt).toBeDisabled();
    await setup(panel);
    const safeStorage = async () => {
      const all = await worker.evaluate(async () => ({ local: await chrome.storage.local.get<{ settings: StoredSettings }>(null), session: await chrome.storage.session.get<Record<string, ArticleSession>>(null) }));
      for (const value of ['fake-test-key', password, changedPassword]) expect(JSON.stringify(all)).not.toContain(value);
      expect(all.local.settings.version).toBe(2);
      for (const config of Object.values(all.local.settings.providers)) expect(config).not.toHaveProperty('apiKey');
    };
    await safeStorage();
    await panel.getByRole('button', { name: 'Give me the short version' }).click();
    await expect(panel.getByRole('button', { name: 'Copy answer' })).toBeVisible();
    expect(calls.some(call => call.body && call.headers.authorization === 'Bearer fake-test-key')).toBe(true);
    await safeStorage();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('3 available models found.');
    await expect(panel.getByLabel('API key', { exact: true })).toHaveValue('fake-test-key');
    const second = await context.newPage(); await second.goto(panelURL); await article.bringToFront();
    await expect(second.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await unlock(second); await expect(second.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    // A second panel can update credentials while this settings form is open.
    await second.getByRole('button', { name: 'Settings', exact: true }).click();
    await second.getByRole('button', { name: 'Save settings' }).click();
    await expect(second.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('alert')).toContainText('another panel');
    await panel.getByRole('button', { name: 'Back to article' }).click();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByRole('button', { name: 'Change master password' }).click();
    const save = panel.getByRole('button', { name: 'Save settings' });
    await expect(save).toBeDisabled();
    await panel.getByLabel('New master password', { exact: true }).fill(changedPassword);
    await panel.getByLabel('Confirm master password', { exact: true }).fill(changedPassword);
    await expect(save).toBeDisabled();
    await panel.getByLabel('Current master password', { exact: true }).fill('incorrect password');
    await expect(save).toBeEnabled();
    await panel.getByLabel('Confirm master password', { exact: true }).fill(password);
    await expect(save).toBeDisabled();
    await panel.getByLabel('Confirm master password', { exact: true }).fill(changedPassword);
    const oldVault = await worker.evaluate(async () => (await chrome.storage.local.get<{ settings: StoredSettings }>('settings')).settings.vault);
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('alert')).toContainText('password is incorrect');
    expect(await worker.evaluate(async () => (await chrome.storage.local.get<{ settings: StoredSettings }>('settings')).settings.vault)).toEqual(oldVault);
    await panel.getByLabel('Current master password', { exact: true }).fill(password);
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await expect(second.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await unlock(second); await expect(second.getByRole('alert')).toContainText('password is incorrect');
    await unlock(second, changedPassword); await expect(second.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Lock vault' }).click();
    await expect(panel.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(second.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(panel.locator('#api-key')).toHaveCount(0);
    await safeStorage();
    await panel.getByRole('button', { name: 'Forgot your master password?' }).click();
    await expect(panel.getByRole('button', { name: 'Delete saved keys and reset' })).toBeDisabled();
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: 'Delete saved keys and reset' }).click();
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(panel.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(panel.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const reset = await worker.evaluate(async () => (await chrome.storage.local.get<{ settings: StoredSettings }>('settings')).settings);
    expect(reset.vault).toBeNull(); expect(reset.provider).toBe('openai'); expect(reset.providers.openai.model).toBe('simulate-success');
    expect(JSON.stringify(calls)).not.toContain(password); expect(JSON.stringify(calls)).not.toContain(changedPassword); expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('locks after inactivity and reopening, and aborts a generation when locked', async () => {
  const settings = legacy(); settings.providers.openai.model = 'simulate-slow';
  const fixture = await launchFixture(settings); const { panel, article, worker, context, panelURL, errors } = fixture;
  try {
    await setup(panel);
    await panel.clock.install();
    // A user action starts a fresh inactivity window.
    await panel.locator('.brand').click();
    await panel.clock.fastForward(14 * 60_000);
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await panel.clock.fastForward(60_001);
    await expect(panel.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await panel.clock.resume(); await unlock(panel);
    await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    // Simulate elapsed wall time while the browser suspended timers.
    await panel.clock.setSystemTime(new Date(Date.now() + 40 * 60_000));
    await panel.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(panel.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await unlock(panel);
    await panel.getByRole('button', { name: 'Give me the short version' }).click();
    await expect(panel.getByRole('button', { name: 'Stop generation' })).toBeVisible();
    await panel.getByRole('button', { name: 'Lock vault' }).click();
    await expect(panel.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
    const sessions = await worker.evaluate(async () => Object.values(await chrome.storage.session.get<Record<string, ArticleSession>>(null)));
    expect(sessions.every(session => !session.messages?.some((message: { status: string }) => message.status === 'streaming'))).toBe(true);
    await unlock(panel); await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await panel.close();
    const reopened = await context.newPage(); await reopened.goto(panelURL); await article.bringToFront();
    await expect(reopened.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('persists interface language separately from output language, including the locked screen', async () => {
  const fixture = await launchFixture(defaultSettings()); const { panel, article, worker, errors } = fixture;
  try {
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByLabel('Interface language').selectOption('pt');
    await expect(panel.getByRole('heading', { name: 'Do seu jeito' })).toBeVisible();
    await panel.getByRole('button', { name: 'Voltar ao artigo' }).click();
    await expect(panel.locator('html')).toHaveAttribute('lang', 'en');
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByLabel('Interface language').selectOption('es');
    await expect(panel.getByRole('heading', { name: 'A tu manera' })).toBeVisible();
    await panel.getByLabel('Idioma de la interfaz').selectOption('it');
    await expect(panel.getByRole('heading', { name: 'A modo tuo' })).toBeVisible();
    await panel.getByLabel('Lingua dell’interfaccia').selectOption('pt');
    await panel.getByRole('button', { name: 'Escuro', exact: true }).click();
    await panel.getByLabel('Nova senha mestra', { exact: true }).fill(password);
    await panel.getByLabel('Confirmar senha mestra', { exact: true }).fill(password);
    for (const width of [320, 390, 600]) {
      await panel.setViewportSize({ width, height: 844 });
      expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await panel.evaluate(() => [...document.querySelectorAll('input, select, button')].every(el => el.getBoundingClientRect().right <= innerWidth))).toBe(true);
    }
    await panel.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('button', { name: 'Salvar configurações' }).click();
    await panel.getByLabel('Ler em', { exact: true }).selectOption('sv');
    expect(await panel.locator('#language option').count()).toBeGreaterThanOrEqual(33);
    await panel.getByRole('button', { name: 'Quero a versão curta' }).click();
    await expect(panel.getByRole('button', { name: 'Copiar resposta' })).toBeVisible();
    const requests = await fetch('http://127.0.0.1:4320/ollama/_requests').then(response => response.json());
    expect(requests.requests.at(-1).body.messages[0].content).toContain('Svenska');
    expect(await worker.evaluate(async () => (await chrome.storage.local.get<{ settings: StoredSettings }>('settings')).settings.language)).toBe('sv');
    await panel.getByRole('button', { name: 'Configurações', exact: true }).click();
    await panel.screenshot({ path: 'test-results/portuguese-settings.png', animations: 'disabled' });
    await panel.reload(); await article.bringToFront();
    await expect(panel.locator('html')).toHaveAttribute('lang', 'pt');
    await expect(panel.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(panel.getByRole('heading', { name: 'Boas-vindas de volta' })).toBeVisible();
    await panel.screenshot({ path: 'test-results/portuguese-vault.png', animations: 'disabled' });
    await panel.getByLabel('Senha mestra', { exact: true }).fill(password);
    await panel.getByRole('button', { name: 'Desbloquear cofre' }).click();
    await expect(panel.getByLabel('Ler em', { exact: true })).toHaveValue('sv');
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});
