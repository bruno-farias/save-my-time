// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CredentialStore, type SettingsStorage } from '../src/lib/credential-store';
import { createEncryptedVault, decryptKeys, emptyKeys, encryptKeys, unlockEncryptedVault, validateVault } from '../src/lib/vault-crypto';
import { defaultSettings } from '../src/lib/settings';

const password = 'test-only passphrase 🍃';
const replacement = 'another test-only passphrase';
const keys = { openai: 'fake-openai-secret', anthropic: 'fake-claude-secret', gemini: 'fake-gemini-secret' };
function fixture() {
  const settings = defaultSettings(); settings.provider = 'openai'; settings.theme = 'dark'; settings.uiLanguage = 'pt'; settings.language = 'sv';
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) settings.providers[provider].apiKey = keys[provider];
  settings.providers.openai.model = 'my-selected-model';
  return settings;
}
function memory(initial: unknown = undefined) {
  let record = structuredClone(initial);
  let queue: Promise<unknown> = Promise.resolve();
  const control = { fail: false, beforeRead: undefined as (() => Promise<void>) | undefined, beforeWrite: undefined as (() => Promise<void>) | undefined };
  const storage: SettingsStorage = {
    async read() { await control.beforeRead?.(); return structuredClone(record); },
    async write(value) { await control.beforeWrite?.(); if (control.fail) throw new Error('Storage unavailable'); record = structuredClone(value); },
    exclusive<T>(work: () => Promise<T>) { const result = queue.catch(() => {}).then(work); queue = result; return result; },
  };
  return { storage, control, peek: () => structuredClone(record) as Record<string, any> };
}
function observed<T>(promise: Promise<T>): Promise<T> {
  // A deliberate mutant can reject before the barrier is reached. Attach a
  // handler immediately so this remains a test failure/timeout, not a runner crash.
  void promise.catch(() => {});
  return promise;
}
function barrier() {
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { paused, release, block: async () => { entered(); await wait; } };
}
function expectNoPlaintext(record: unknown) {
  const serialized = JSON.stringify(record);
  for (const secret of [...Object.values(keys), password, replacement]) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('"apiKey"');
  expect(serialized).not.toContain('vaultRevision');
}

describe('Web Crypto vault', () => {
  it('encrypts all providers and round trips through a non-extractable AES key', async () => {
    const { key, vault } = await createEncryptedVault(password, keys);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    expectNoPlaintext(vault);
    expect(vault.iterations).toBe(600_000);
    expect(atob(vault.salt)).toHaveLength(32); expect(atob(vault.iv)).toHaveLength(12);
    expect((await unlockEncryptedVault(password, vault)).keys).toEqual(keys);
  });
  it('uses a fresh salt for each vault and a fresh IV and authenticated revision for every save', async () => {
    const first = await createEncryptedVault(password, keys);
    const second = await createEncryptedVault(password, keys);
    const update = await encryptKeys(first.key, first.vault, keys);
    expect(first.vault.salt).not.toBe(second.vault.salt);
    expect(update.salt).toBe(first.vault.salt);
    expect(update.iv).not.toBe(first.vault.iv); expect(update.revision).not.toBe(first.vault.revision);
    expect(update.ciphertext).not.toBe(first.vault.ciphertext);
    expect(await decryptKeys(first.key, update)).toEqual(keys);
  });
  it('rejects a wrong password and altered ciphertext or authenticated metadata', async () => {
    const { key, vault } = await createEncryptedVault(password, keys);
    await expect(unlockEncryptedVault(replacement, vault)).rejects.toThrow('password is incorrect');
    for (const change of [{ id: crypto.randomUUID() }, { revision: crypto.randomUUID() }, { iv: btoa('123456789012') }, { ciphertext: (vault.ciphertext[0] === 'A' ? 'B' : 'A') + vault.ciphertext.slice(1) }]) {
      await expect(decryptKeys(key, { ...vault, ...change })).rejects.toThrow();
    }
    expect(await decryptKeys(key, vault)).toEqual(keys);
  });
  it('rejects short passwords, unsupported formats, and oversized input without emitting an unreadable vault', async () => {
    await expect(createEncryptedVault('short', keys)).rejects.toThrow('12 characters');
    await expect(createEncryptedVault('a'.repeat(1025), keys)).rejects.toThrow('too long');
    const { key, vault } = await createEncryptedVault(password, emptyKeys());
    for (const change of [{ iterations: 1 }, { iterations: 1e12 }, { version: 2 }, { salt: '!' }, { iv: '!' }, { ciphertext: '' }, { algorithm: 'AES-CBC' }]) expect(() => validateVault({ ...vault, ...change })).toThrow('unsupported format');
    await expect(encryptKeys(key, vault, { ...keys, openai: 'a'.repeat(8193) })).rejects.toThrow('invalid API key');
    await expect(encryptKeys(key, vault, { openai: '\0'.repeat(8192), anthropic: '\0'.repeat(8192), gemini: '\0'.repeat(8192) })).rejects.toThrow('too large');
  });
});

describe('credential persistence and migration', () => {
  it('requires migration, keeps secrets out of the overview, and replaces plaintext in one write', async () => {
    const db = memory(fixture()); const store = new CredentialStore(db.storage);
    const overview = await store.overview(); expect(overview.mode).toBe('migration');
    expect(overview.settings.providers.openai.apiKey).toBe('');
    await expect(store.load()).rejects.toThrow('Create a master password');
    await expect(store.save(fixture(), true)).rejects.toThrow('Create a master password');
    const loaded = await store.create(password);
    expect(loaded.providers.openai.apiKey).toBe(keys.openai);
    expect(loaded.providers.openai.model).toBe('my-selected-model');
    expect(loaded.uiLanguage).toBe('pt'); expect(loaded.language).toBe('sv'); expect(loaded.theme).toBe('dark');
    expect(db.peek().version).toBe(2); expectNoPlaintext(db.peek());
    store.lock(); expect((await store.overview()).mode).toBe('locked');
    await expect(store.load()).rejects.toThrow('locked');
    await store.unlock(password); expect((await store.load()).providers.gemini.apiKey).toBe(keys.gemini);
  });
  it('keeps legacy credentials intact if migration storage fails and permits a safe retry', async () => {
    const legacy = fixture(), db = memory(legacy), store = new CredentialStore(db.storage);
    db.control.fail = true;
    await expect(store.create(password)).rejects.toThrow('Storage unavailable');
    expect(db.peek()).toEqual(legacy); expect(store.isUnlocked()).toBe(false);
    db.control.fail = false; await store.create(password); expectNoPlaintext(db.peek());
  });
  it('never persists new keys without an explicitly created vault', async () => {
    const db = memory(), store = new CredentialStore(db.storage);
    await expect(store.save(fixture())).rejects.toThrow('Create a master password');
    expect(db.peek()).toBeUndefined();
    const result = await store.create(password, fixture()); expect(result.providers.openai.apiKey).toBe(keys.openai);
    const original = db.peek();
    await expect(store.create(password, defaultSettings())).rejects.toThrow('already exists');
    expect(db.peek()).toEqual(original);
  });
  it('preserves encrypted values on failed saves, then safely removes a key', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    const loaded = await store.create(password), before = db.peek();
    loaded.providers.openai.apiKey = ''; db.control.fail = true;
    await expect(store.save(loaded, true)).rejects.toThrow('Storage unavailable');
    expect(db.peek()).toEqual(before); expect((await store.load()).providers.openai.apiKey).toBe(keys.openai);
    db.control.fail = false; await store.save(loaded, true);
    expect((await store.load()).providers.openai.apiKey).toBe('');
    expect((await store.load()).providers.anthropic.apiKey).toBe(keys.anthropic); expectNoPlaintext(db.peek());
  });
  it('rotates with fresh salt and key, requires the current password, and invalidates the old password', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    const loaded = await store.create(password), before = db.peek();
    await expect(store.changePassword('incorrect', replacement, loaded)).rejects.toThrow('password is incorrect');
    expect(db.peek()).toEqual(before);
    db.control.fail = true; await expect(store.changePassword(password, replacement, loaded)).rejects.toThrow('Storage unavailable');
    expect(db.peek()).toEqual(before); db.control.fail = false;
    await store.changePassword(password, replacement, loaded);
    expect(db.peek().vault.salt).not.toBe(before.vault.salt); expectNoPlaintext(db.peek());
    store.lock(); await expect(store.unlock(password)).rejects.toThrow('password is incorrect');
    expect(store.isUnlocked()).toBe(false);
    await store.unlock(replacement); expect((await store.load()).providers.anthropic.apiKey).toBe(keys.anthropic);
  });
  it('keeps newer credentials when another panel saves preferences and rejects stale key edits', async () => {
    const db = memory(fixture()), first = new CredentialStore(db.storage), second = new CredentialStore(db.storage);
    const old = await first.create(password); await second.unlock(password);
    const fresh = await second.load(); fresh.providers.openai.apiKey = 'fake-new-key';
    await second.save(fresh, true);
    old.length = 'short';
    const result = await first.save(old);
    expect(result.providers.openai.apiKey).toBe('fake-new-key'); expect(result.length).toBe('short');
    const before = db.peek(); await expect(first.save(old, true)).rejects.toThrow('another panel'); expect(db.peek()).toEqual(before);
    expectNoPlaintext(db.peek()); expect(JSON.stringify(db.peek())).not.toContain('fake-new-key');
  });
  it('detects rotations in other panels and refuses use of an obsolete key', async () => {
    const db = memory(fixture()), first = new CredentialStore(db.storage), second = new CredentialStore(db.storage);
    await first.create(password); await second.unlock(password); const before = db.peek();
    await first.changePassword(password, replacement, await first.load());
    expect(first.observeChange(db.peek(), before)).toBe(false);
    expect(second.observeChange(db.peek(), before)).toBe(true);
    await expect(second.load()).rejects.toThrow('locked'); expect(second.isUnlocked()).toBe(false);
  });
  it('does not re-unlock when locking during an asynchronous unlock or save', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    const loaded = await store.create(password); store.lock();
    const read = barrier(); db.control.beforeRead = read.block;
    const opening = observed(store.unlock(password)); await read.paused; store.lock(); read.release();
    await expect(opening).rejects.toThrow('locked while'); expect(store.isUnlocked()).toBe(false);
    db.control.beforeRead = undefined; await store.unlock(password);
    const write = barrier(); db.control.beforeWrite = write.block;
    const saving = observed(store.save(loaded, true)); await write.paused; store.lock(); write.release();
    await expect(saving).rejects.toThrow('locked while'); expect(store.isUnlocked()).toBe(false); expectNoPlaintext(db.peek());
  });
  it('does not install a new session if a panel closes during vault creation', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage), write = barrier();
    db.control.beforeWrite = write.block;
    const creating = observed(store.create(password)); await write.paused; store.lock(); write.release();
    await expect(creating).rejects.toThrow('locked while'); expect(store.isUnlocked()).toBe(false); expectNoPlaintext(db.peek());
    db.control.beforeWrite = undefined; await store.unlock(password); expect((await store.load()).providers.openai.apiKey).toBe(keys.openai);
  });
  it('resets credentials while retaining preferences, and reports corrupt envelopes without rewriting them', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    await store.create(password); const corrupt = db.peek(); corrupt.vault.iterations = 1; await db.storage.write(corrupt);
    expect((await store.overview()).mode).toBe('corrupt'); expect(store.isUnlocked()).toBe(false); expect(db.peek()).toEqual(corrupt);
    db.control.fail = true; await expect(store.reset()).rejects.toThrow('Storage unavailable'); expect(db.peek()).toEqual(corrupt);
    db.control.fail = false; await store.reset();
    expect((await store.overview()).mode).toBe('none');
    const settings = await store.load(); expect(settings.providers.openai.apiKey).toBe(''); expect(settings.theme).toBe('dark'); expect(settings.uiLanguage).toBe('pt');
    expect(db.peek().vault).toBeNull(); expectNoPlaintext(db.peek());
  });
});


describe('vault state transitions', () => {
  it.each(['openai', 'anthropic', 'gemini'] as const)('requires a vault even when only the %s key is set', async provider => {
    const settings = defaultSettings(); settings.providers[provider].apiKey = 'fake-single-key';
    const db = memory(settings), store = new CredentialStore(db.storage);
    expect((await store.overview()).mode).toBe('migration');
    await expect(store.load()).rejects.toThrow('Create a master password');
    await expect(store.save(defaultSettings())).rejects.toThrow('Create a master password');
    expect(db.peek()).toEqual(settings);
  });
  it('saves local-only preferences without creating a vault', async () => {
    const db = memory(null), store = new CredentialStore(db.storage), settings = defaultSettings();
    settings.theme = 'dark';
    expect((await store.overview()).mode).toBe('none');
    expect(await store.save(settings)).toEqual(settings);
    expect(db.peek().vault).toBeNull(); expect(store.isUnlocked()).toBe(false);
    expectNoPlaintext(db.peek());
  });
  it('preserves an unlocked session through overview and clears it on reset', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    await store.create(password);
    expect(store.isUnlocked()).toBe(true); expect((await store.overview()).mode).toBe('unlocked');
    expect((await store.load()).providers.openai.apiKey).toBe(keys.openai);
    await store.reset(); expect(store.isUnlocked()).toBe(false);
    expect((await store.overview()).mode).toBe('none');
  });
  it.each(['id', 'salt'] as const)('locks when only the saved %s changes', async field => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    await store.create(password); const previous = db.peek(), changed = structuredClone(previous);
    changed.vault.revision = crypto.randomUUID();
    changed.vault[field] = field === 'id' ? crypto.randomUUID() : btoa('x'.repeat(32));
    expect(store.observeChange(changed, previous)).toBe(true);
    await db.storage.write(changed);
    expect((await store.overview()).mode).toBe('locked'); expect(store.isUnlocked()).toBe(false);
    await expect(store.load()).rejects.toThrow('locked');
  });
  it('distinguishes creation, reset, and preference/key changes in other panels', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage), observer = new CredentialStore(db.storage);
    await store.create(password); const original = db.peek();
    expect(observer.observeChange(original, null)).toBe(true);
    expect(observer.observeChange(null, original)).toBe(true);
    expect(observer.observeChange(null, null)).toBe(false);
    expect(observer.observeChange({ theme: 'dark' }, { theme: 'light' })).toBe(false);
    const updated = structuredClone(original); updated.vault.revision = crypto.randomUUID();
    expect(observer.observeChange(updated, original)).toBe(false);
  });
  it('refuses password rotation from a locked or stale settings form', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    const stale = await store.create(password); const current = await store.load();
    current.providers.openai.apiKey = 'fake-changed-key'; await store.save(current, true);
    const before = db.peek();
    await expect(store.changePassword(password, replacement, stale)).rejects.toThrow('another panel');
    expect(db.peek()).toEqual(before);
    const fresh = await store.load(); store.lock();
    await expect(store.changePassword(password, replacement, fresh)).rejects.toThrow('locked');
    expect(db.peek()).toEqual(before);
  });
  it('keeps the newly rotated vault usable before closing the panel', async () => {
    const db = memory(fixture()), store = new CredentialStore(db.storage);
    const loaded = await store.create(password);
    await store.changePassword(password, replacement, loaded);
    expect(store.isUnlocked()).toBe(true);
    expect((await store.load()).providers.openai.apiKey).toBe(keys.openai);
  });
});
