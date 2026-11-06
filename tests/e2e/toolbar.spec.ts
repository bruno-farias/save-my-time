import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSettings, launchFixture } from './helpers';

test('toolbar handler toggles native panels per window, handles manual close, and supports the older close fallback', async () => {
  const fixture = await launchFixture(defaultSettings(), async directory => {
    // Headless browsers do not dispatch native toolbar accelerators. Relay a
    // real click from a TEST-ONLY extension page to the exact action listener.
    // Everything after that listener, including getContexts/open/close, is real.
    const background = await readFile(join(directory, 'background.js'), 'utf8');
    await writeFile(join(directory, 'background.js'), `
      globalThis.fixtureOpenErrors = [];
      const fixtureOpen = chrome.sidePanel.open.bind(chrome.sidePanel);
      chrome.sidePanel.open = options => fixtureOpen(options).catch(error => { globalThis.fixtureOpenErrors.push(error.message); throw error; });
      let fixtureToolbarListener;
      const fixtureOriginalAdd = chrome.action.onClicked.addListener.bind(chrome.action.onClicked);
      chrome.action.onClicked.addListener = listener => { fixtureToolbarListener = listener; fixtureOriginalAdd(listener); };
      chrome.runtime.onMessage.addListener((message, sender, reply) => {
        if (message.type === 'FIXTURE_TOOLBAR_CLICK' && sender.tab) { fixtureToolbarListener(sender.tab); reply(true); }
      });
      ${background}
    `);
    await writeFile(join(directory, 'toolbar-fixture.html'), '<!doctype html><button>Toggle panel</button><script src="toolbar-fixture.js"></script>');
    await writeFile(join(directory, 'toolbar-fixture.js'), "document.querySelector('button').addEventListener('click', () => { void chrome.runtime.sendMessage({type:'FIXTURE_TOOLBAR_CLICK'}); });");
    const panel = await readFile(join(directory, 'sidepanel.html'), 'utf8');
    await writeFile(join(directory, 'sidepanel.html'), panel.replace('</body>', '<script src="panel-fixture.js"></script></body>'));
    await writeFile(join(directory, 'panel-fixture.js'), "chrome.runtime.onMessage.addListener((message, sender, reply) => { if (message.type === 'FIXTURE_PANEL_READY') reply(Boolean(document.getElementById('root')?.firstElementChild)); });");
  });
  const { panel, context, worker, panelURL, errors } = fixture;
  try {
    const fixtureURL = panelURL.replace('sidepanel.html', 'toolbar-fixture.html');
    await panel.goto(fixtureURL);
    const originalWindowId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id!);
    const panels = () => worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
    const panelInWindow = (windowId: number) => worker.evaluate(async windowId => {
      const panelUrl = (await chrome.storage.session.get(`side-panel-window:${windowId}`))[`side-panel-window:${windowId}`];
      return (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).some(panel => panel.documentUrl === panelUrl);
    }, windowId);
    await expect.poll(panels).toHaveLength(0);
    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(1);
    await expect.poll(() => panelInWindow(originalWindowId)).toBe(true);
    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(0);
    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(1);
    // The browser's own close action must not leave stale toggle state.
    await worker.evaluate(windowId => chrome.sidePanel.close({ windowId }), originalWindowId);
    await expect.poll(panels).toHaveLength(0);
    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(1);

    const otherPage = context.waitForEvent('page');
    const secondWindow = await worker.evaluate(url => chrome.windows.create({ url, type: 'normal' }), fixtureURL);
    const other = await otherPage; await other.waitForLoadState();
    await other.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(2);
    await expect.poll(() => panelInWindow(secondWindow!.id!)).toBe(true);
    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(1);
    expect(await panelInWindow(secondWindow!.id!)).toBe(true);
    expect(await panelInWindow(originalWindowId)).toBe(false);
    await worker.evaluate(windowId => chrome.windows.remove(windowId!), secondWindow!.id);
    await expect.poll(panels).toHaveLength(0);

    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(1);
    await expect.poll(() => worker.evaluate(() => chrome.runtime.sendMessage({ type: 'FIXTURE_PANEL_READY' }).catch(() => false))).toBe(true);
    await worker.evaluate(() => { Object.defineProperty(chrome.sidePanel, 'close', { value: undefined, configurable: true }); });
    await panel.getByRole('button', { name: 'Toggle panel' }).click();
    await expect.poll(panels).toHaveLength(0);
    expect(panel.isClosed()).toBe(false);
    expect(await worker.evaluate(() => (globalThis as typeof globalThis & { fixtureOpenErrors: string[] }).fixtureOpenErrors)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});
