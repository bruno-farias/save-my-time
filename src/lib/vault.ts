import { CredentialStore, type SettingsStorage } from './credential-store';
export { settingsHaveKeys, type VaultOverview } from './credential-store';
const extension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
let previewRecord: unknown;
let queue: Promise<unknown> = Promise.resolve();
const storage: SettingsStorage = {
  async read() {
    if (!extension) return structuredClone(previewRecord);
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return (await chrome.storage.local.get('settings')).settings;
  },
  async write(settings) {
    if (!extension) { previewRecord = structuredClone(settings); return; }
    await chrome.storage.local.set({ settings });
  },
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('save-my-time:settings', work);
    const result = queue.catch(() => {}).then(work);
    queue = result;
    return result;
  },
};
export const credentials = new CredentialStore(storage);
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
export function onVaultLocked(listener: () => void) {
  listeners.add(listener);
  if (typeof BroadcastChannel !== 'undefined' && !channel) {
    channel = new BroadcastChannel('save-my-time:vault-lock');
    channel.onmessage = event => { if (event.data === 'lock') lockVault(false); };
  }
  return () => { listeners.delete(listener); if (!listeners.size) { channel?.close(); channel = null; } };
}
export function lockVault(broadcast = true) {
  credentials.lock();
  if (broadcast) channel?.postMessage('lock');
  listeners.forEach(listener => listener());
}
