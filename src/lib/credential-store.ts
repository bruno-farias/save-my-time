import { normalizeSettings } from './settings';
import type { Settings } from './types';
import { createEncryptedVault, decryptKeys, emptyKeys, encryptKeys, KEY_PROVIDERS, unlockEncryptedVault, validateVault, type ApiKeys, type EncryptedVault } from './vault-crypto';
import { t } from './i18n';

export type VaultMode = 'none' | 'migration' | 'locked' | 'unlocked' | 'corrupt';
export interface VaultOverview { mode: VaultMode; settings: Settings }
export interface SettingsStorage {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}
export interface StoredSettings extends Omit<Settings, 'version' | 'providers' | 'vaultRevision'> {
  version: 2;
  providers: Record<keyof Settings['providers'], { model: string; baseUrl: string }>;
  vault: EncryptedVault | null;
}
export class VaultRequiredError extends Error { constructor() { super(t('Create a master password before saving API keys.')); } }
const rawVault = (value: unknown): unknown => value && typeof value === 'object' ? (value as { vault?: unknown }).vault : undefined;
export function settingsHaveKeys(settings: Settings): boolean { return KEY_PROVIDERS.some(provider => Boolean(settings.providers[provider].apiKey)); }
const keysFrom = (settings: Settings): ApiKeys => Object.fromEntries(KEY_PROVIDERS.map(provider => [provider, settings.providers[provider].apiKey])) as ApiKeys;
function withoutKeys(settings: Settings): Settings {
  const clean = normalizeSettings(settings);
  for (const config of Object.values(clean.providers)) config.apiKey = '';
  delete clean.vaultRevision;
  return clean;
}
function storedSettings(settings: Settings, vault: EncryptedVault | null): StoredSettings {
  const { providers, vaultRevision: _revision, ...preferences } = withoutKeys(settings);
  return { ...preferences, version: 2, providers: Object.fromEntries(Object.entries(providers).map(([id, config]) => [id, { model: config.model, baseUrl: config.baseUrl }])) as StoredSettings['providers'], vault };
}
function withKeys(settings: Settings, keys: ApiKeys, revision: string): Settings {
  const result = withoutKeys(settings);
  for (const provider of KEY_PROVIDERS) result.providers[provider].apiKey = keys[provider];
  result.vaultRevision = revision;
  return result;
}

// Only the non-extractable CryptoKey is retained here, in this panel's memory.
// All persisted values pass through storedSettings; no caller can save plaintext
// keys, even while the vault is unlocked.
export class CredentialStore {
  private session: { key: CryptoKey; id: string; salt: string } | null = null;
  private epoch = 0;
  private ownRevision: string | null = null;
  constructor(private storage: SettingsStorage) {}
  isUnlocked() { return this.session !== null; }
  lock() { ++this.epoch; this.session = null; }
  observeChange(next: unknown, previous: unknown): boolean {
    const current = rawVault(next) as Partial<EncryptedVault> | undefined;
    const old = rawVault(previous) as Partial<EncryptedVault> | undefined;
    if (current?.revision && current.revision === this.ownRevision) return false;
    return current?.id !== old?.id || current?.salt !== old?.salt;
  }
  private async write(settings: Settings, vault: EncryptedVault | null) {
    this.ownRevision = vault?.revision || null;
    try { await this.storage.write(storedSettings(settings, vault)); }
    catch (cause) { this.ownRevision = null; throw cause; }
  }
  private currentKey(vault: EncryptedVault) {
    if (!this.session || this.session.id !== vault.id || this.session.salt !== vault.salt) {
      this.lock(); throw new Error(t('Your vault is locked. Unlock it to use saved API keys.'));
    }
    return this.session.key;
  }
  private assertEpoch(epoch: number) {
    if (this.epoch !== epoch) throw new Error(t('The vault was locked while this operation was running. Unlock it and try again.'));
  }
  async overview(): Promise<VaultOverview> {
    const raw = await this.storage.read();
    const settings = normalizeSettings(raw);
    const encrypted = rawVault(raw);
    let mode: VaultMode;
    if (encrypted != null) {
      try {
        const vault = validateVault(encrypted);
        mode = this.session?.id === vault.id && this.session?.salt === vault.salt ? 'unlocked' : 'locked';
        if (mode === 'locked') this.lock();
      } catch { this.lock(); mode = 'corrupt'; }
    } else { mode = settingsHaveKeys(settings) ? 'migration' : 'none'; }
    return { mode, settings: withoutKeys(settings) };
  }
  async load(): Promise<Settings> {
    const epoch = this.epoch;
    return this.storage.exclusive(async () => {
      this.assertEpoch(epoch);
      const raw = await this.storage.read();
      const settings = normalizeSettings(raw);
      const encrypted = rawVault(raw);
      if (encrypted != null) {
        const vault = validateVault(encrypted);
        const keys = await decryptKeys(this.currentKey(vault), vault);
        this.assertEpoch(epoch);
        return withKeys(settings, keys, vault.revision);
      }
      if (settingsHaveKeys(settings)) throw new VaultRequiredError();
      return withoutKeys(settings);
    });
  }
  async unlock(password: string): Promise<void> {
    const epoch = this.epoch;
    // Hold the cross-panel lock through decryption so a concurrent rotation or
    // reset cannot install an obsolete key in this panel.
    return this.storage.exclusive(async () => {
      this.assertEpoch(epoch);
      const vault = validateVault(rawVault(await this.storage.read()));
      const { key } = await unlockEncryptedVault(password, vault);
      this.assertEpoch(epoch);
      this.session = { key, id: vault.id, salt: vault.salt };
    });
  }
  async create(password: string, next?: Settings): Promise<Settings> {
    const epoch = this.epoch;
    return this.storage.exclusive(async () => {
      this.assertEpoch(epoch);
      const raw = await this.storage.read();
      if (rawVault(raw) != null) throw new Error(t('A vault already exists. Unlock it to change your saved keys.'));
      // Read legacy keys only here; replacing the single settings record
      // migrates them without an intermediate plaintext copy or destructive clear.
      const settings = normalizeSettings(next || raw);
      const { key, vault } = await createEncryptedVault(password, keysFrom(settings));
      this.assertEpoch(epoch);
      await this.write(settings, vault);
      this.assertEpoch(epoch);
      this.session = { key, id: vault.id, salt: vault.salt };
      return withKeys(settings, keysFrom(settings), vault.revision);
    });
  }
  async save(next: Settings, updateKeys = false): Promise<Settings> {
    const epoch = this.epoch;
    return this.storage.exclusive(async () => {
      this.assertEpoch(epoch);
      const raw = await this.storage.read();
      const settings = normalizeSettings(next);
      const encrypted = rawVault(raw);
      let vault = encrypted == null ? null : validateVault(encrypted);
      let keys = emptyKeys();
      if (vault) {
        const key = this.currentKey(vault);
        keys = await decryptKeys(key, vault);
        this.assertEpoch(epoch);
        if (updateKeys) {
          if (next.vaultRevision !== vault.revision) throw new Error(t('Saved keys changed in another panel. Close and reopen settings before saving again.'));
          keys = keysFrom(settings);
          vault = await encryptKeys(key, vault, keys);
        }
      } else if (settingsHaveKeys(normalizeSettings(raw)) || settingsHaveKeys(settings)) throw new VaultRequiredError();
      this.assertEpoch(epoch);
      await this.write(settings, vault);
      this.assertEpoch(epoch);
      return vault ? withKeys(settings, keys, vault.revision) : withoutKeys(settings);
    });
  }
  async changePassword(currentPassword: string, newPassword: string, next: Settings): Promise<Settings> {
    const epoch = this.epoch;
    return this.storage.exclusive(async () => {
      this.assertEpoch(epoch);
      const old = validateVault(rawVault(await this.storage.read()));
      this.currentKey(old);
      if (next.vaultRevision !== old.revision) throw new Error(t('Saved keys changed in another panel. Close and reopen settings before saving again.'));
      await unlockEncryptedVault(currentPassword, old);
      const settings = normalizeSettings(next);
      const { key, vault } = await createEncryptedVault(newPassword, keysFrom(settings));
      this.assertEpoch(epoch);
      await this.write(settings, vault);
      this.assertEpoch(epoch);
      this.session = { key, id: vault.id, salt: vault.salt };
      return withKeys(settings, keysFrom(settings), vault.revision);
    });
  }
  async reset(): Promise<void> {
    return this.storage.exclusive(async () => {
      const settings = normalizeSettings(await this.storage.read());
      await this.write(settings, null);
      this.lock();
    });
  }
}
