// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest';
import { createEncryptedVault, decryptKeys, emptyKeys, encryptKeys, unlockEncryptedVault, validateMasterPassword, validateVault, type EncryptedVault } from '../src/lib/vault-crypto';

let key: CryptoKey;
let vault: EncryptedVault;
beforeAll(async () => {
  // Build an independent valid envelope. A mutant must fail inside a test,
  // rather than crashing shared setup before assertions can run.
  key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  vault = { version: 1, id: crypto.randomUUID(), revision: crypto.randomUUID(), kdf: 'PBKDF2-SHA-256', iterations: 600000, salt: encode(crypto.getRandomValues(new Uint8Array(32))), algorithm: 'AES-GCM-256', iv: encode(iv), ciphertext: '' };
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`save-my-time:api-keys:v1:${vault.id}:${vault.revision}`), tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify({ version: 1, keys: { openai: '', anthropic: '', gemini: '' } })));
  vault.ciphertext = encode(new Uint8Array(encrypted));
});

it.each([12, 1024])('accepts a password at the valid %i-character boundary', length => {
  expect(() => validateMasterPassword('a'.repeat(length))).not.toThrow();
});
it.each([0, 11, 1025])('rejects a password outside the valid boundary: %i characters', length => {
  expect(() => validateMasterPassword('a'.repeat(length))).toThrow();
});
// Keep large payloads out of test names: Stryker uses names in a selection regex.
it.each([
  { version: 0 }, { version: '1' }, { kdf: 'unknown' }, { iterations: 600001 }, { algorithm: 'unknown' },
  { id: null }, { id: 'a'.repeat(35) }, { id: 'a'.repeat(37) }, { id: 'z'.repeat(36) },
  { revision: null }, { revision: 'a'.repeat(35) }, { revision: 'a'.repeat(37) }, { revision: 'z'.repeat(36) },
  { salt: null }, { salt: btoa('x'.repeat(31)) }, { salt: btoa('x'.repeat(33)) }, { salt: 'x'.repeat(49) },
  { iv: null }, { iv: btoa('x'.repeat(11)) }, { iv: btoa('x'.repeat(13)) }, { iv: 'x'.repeat(21) },
  { ciphertext: null }, { ciphertext: btoa('x'.repeat(15)) }, { ciphertext: 'x'.repeat(100001) }, { ciphertext: '!' },
])('rejects invalid vault metadata before decryption (case %#)', change => {
  expect(() => validateVault({ ...vault, ...change })).toThrow('unsupported format');
});
it.each([null, undefined, false, 1, 'vault', {}])('rejects a non-envelope input: %j', input => {
  expect(() => validateVault(input)).toThrow('unsupported format');
});
it('accepts the minimum authentication tag size for structural validation only', () => {
  expect(validateVault({ ...vault, ciphertext: btoa('x'.repeat(16)) }).ciphertext).toBe(btoa('x'.repeat(16)));
});
it('rejects oversized passwords even on unlock', async () => {
  await expect(unlockEncryptedVault('a'.repeat(1025), vault)).rejects.toThrow('too long');
});
it.each(['openai', 'anthropic', 'gemini'] as const)('bounds the %s key without truncation', async provider => {
  const keys = { ...emptyKeys(), [provider]: 'a'.repeat(8192) };
  expect(await decryptKeys(key, await encryptKeys(key, vault, keys))).toEqual(keys);
  await expect(encryptKeys(key, vault, { ...keys, [provider]: 'a'.repeat(8193) })).rejects.toThrow('invalid API key');
});
it.each([null, {}, { openai: '', anthropic: '', gemini: 42 }])('rejects invalid key payloads: %j', keys => {
  return expect(encryptKeys(key, vault, keys as never)).rejects.toThrow('invalid API key');
});
it('omits unknown fields from encrypted credentials', async () => {
  const encrypted = await encryptKeys(key, vault, { ...emptyKeys(), unexpected: 'never retain' } as never);
  expect(await decryptKeys(key, encrypted)).toEqual(emptyKeys());
});
it.each([{ version: 2, keys: emptyKeys() }, { version: 1, keys: null }, { version: 1, keys: { openai: '', anthropic: '', gemini: false } }])('rejects authenticated but invalid decrypted data: %j', async payload => {
  // Encrypt a deliberately unsupported payload using the documented envelope.
  // A valid GCM tag alone must not make its inner schema trusted.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`save-my-time:api-keys:v1:${vault.id}:${vault.revision}`), tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const invalid = { ...vault, iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))) };
  await expect(decryptKeys(key, invalid)).rejects.toThrow('invalid API key');
});

it('returns genuinely empty, independent credential objects', () => {
  const first = emptyKeys(); expect(first).toEqual({ openai: '', anthropic: '', gemini: '' });
  first.openai = 'fake-key'; expect(emptyKeys().openai).toBe('');
});
it('round trips the maximum permitted password length', async () => {
  const password = 'x'.repeat(1024);
  const created = await createEncryptedVault(password, { openai: 'fake-key', anthropic: '', gemini: '' });
  expect((await unlockEncryptedVault(password, created.vault)).keys.openai).toBe('fake-key');
});
it('validates metadata even when decrypting with an already unlocked key', async () => {
  await expect(decryptKeys(key, { ...vault, version: 2 } as never)).rejects.toThrow('unsupported format');
});
it('clears temporary password and plaintext buffers after encryption and decryption', async () => {
  const imported = vi.spyOn(crypto.subtle, 'importKey');
  const encrypted = vi.spyOn(crypto.subtle, 'encrypt');
  const decrypted = vi.spyOn(crypto.subtle, 'decrypt');
  const created = await createEncryptedVault('test-only temporary password', { openai: 'fake-key', anthropic: '', gemini: '' });
  expect(await decryptKeys(created.key, created.vault)).toEqual({ openai: 'fake-key', anthropic: '', gemini: '' });
  const passwordBytes = imported.mock.calls[0][1] as Uint8Array;
  const plaintext = encrypted.mock.calls[0][2] as Uint8Array;
  const decryptedBuffer = await decrypted.mock.results[0].value as ArrayBuffer;
  for (const bytes of [passwordBytes, plaintext, new Uint8Array(decryptedBuffer)]) {
    expect(bytes.byteLength).toBeGreaterThan(0); expect(bytes.every(byte => byte === 0)).toBe(true);
  }
});
