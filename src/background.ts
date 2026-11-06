// Only trusted extension pages can read API keys. The injected reader never
// accesses storage and never receives credentials.
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // Keep the action listener so toolbar clicks receive the activeTab grant.
  // The browser's automatic panel behavior can consume the click instead.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}
void initialize().catch(console.error);
chrome.runtime.onInstalled.addListener(() => { void initialize().catch(console.error); });
const panelWindowKey = (windowId: number) => `side-panel-window:${windowId}`;
chrome.runtime.onMessage.addListener((message: { type?: string; windowId?: number; instance?: string }, sender, reply) => {
  if (message.type !== 'REGISTER_SIDE_PANEL' || sender.id !== chrome.runtime.id || sender.tab
    || sender.url?.split('#')[0] !== chrome.runtime.getURL('sidepanel.html') || typeof message.instance !== 'string' || !/^[a-f\d-]{36}$/i.test(message.instance) || !Number.isInteger(message.windowId) || message.windowId! < 0) return;
  // SIDE_PANEL contexts can report windowId=-1. Retain only the document/window
  // association, then verify the document is still live on every toolbar click.
  void chrome.storage.session.set({ [panelWindowKey(message.windowId!)]: `${chrome.runtime.getURL('sidepanel.html')}#panel-${message.instance}` }).then(() => reply(true), () => reply(false));
  return true;
});
chrome.windows.onRemoved.addListener(windowId => { void chrome.storage.session.remove(panelWindowKey(windowId)); });
const pendingWindows = new Set<number>();
chrome.action.onClicked.addListener(tab => {
  const windowId = tab.windowId;
  if (pendingWindows.has(windowId)) return;
  pendingWindows.add(windowId);
  // Start both native requests in the original gesture. Chaining another API
  // request inside a callback can lose that gesture before sidePanel.open().
  // Read live documents so browser close actions and worker restarts are safe.
  let livePanels: chrome.runtime.ExtensionContext[] | undefined;
  let panelUrl: unknown;
  let associationReady = false;
  const toggle = () => {
    if (!livePanels || !associationReady) return;
    const open = livePanels.some(panel => panel.windowId === windowId || (typeof panelUrl === 'string' && panel.documentUrl === panelUrl));
    const action = open
      ? typeof chrome.sidePanel.close === 'function'
        ? chrome.sidePanel.close({ windowId })
        : chrome.runtime.sendMessage({ type: 'CLOSE_SIDE_PANEL', windowId })
      : chrome.sidePanel.open({ windowId }).then(() => chrome.runtime.sendMessage({ type: 'PAGE_ACCESS_GRANTED', tabId: tab.id }));
    void action.catch(() => { /* A new panel reads on mount; a closed one may already be gone. */ })
      .finally(() => pendingWindows.delete(windowId));
  };
  const key = panelWindowKey(windowId);
  chrome.storage.session.get(key, saved => {
    panelUrl = chrome.runtime.lastError ? undefined : saved[key];
    associationReady = true;
    toggle();
  });
  chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }, contexts => {
    livePanels = chrome.runtime.lastError ? [] : contexts;
    toggle();
  });
});
chrome.tabs.onRemoved.addListener(tabId => { void chrome.storage.session.remove(`article:${tabId}`); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'loading') void chrome.storage.session.remove(`article:${tabId}`);
});
