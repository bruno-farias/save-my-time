import { t } from './i18n';
export const KEY_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type ApiKeys = Record<typeof KEY_PROVIDERS[number], string>;
export interface EncryptedVault {
  version: 1;
  id: string;
  revision: string;
  kdf: 'PBKDF2-SHA-256';
  iterations: 600000;
  salt: string;
  algorithm: 'AES-GCM-256';
  iv: string;
  ciphertext: string;
}
export const KDF_ITERATIONS = 600_000;
export const emptyKeys = (): ApiKeys => ({ openai: '', anthropic: '', gemini: '' });
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function decode(value: string) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
const additionalData = (vault: Pick<EncryptedVault, 'id' | 'revision'>) => new TextEncoder().encode(`save-my-time:api-keys:v1:${vault.id}:${vault.revision}`);
export function validateMasterPassword(password: string) {
  if (password.length < 12) throw new Error(t('Use at least 12 characters for your master password. A long, unique passphrase is best.'));
  if (password.length > 1024) throw new Error(t('The master password is too long. Use up to 1,024 characters.'));
}
export function validateVault(value: unknown): EncryptedVault {
  const v = value as Partial<EncryptedVault> | null;
  try {
    if (!v || v.version !== 1 || v.kdf !== 'PBKDF2-SHA-256' || v.iterations !== KDF_ITERATIONS || v.algorithm !== 'AES-GCM-256'
      || typeof v.id !== 'string' || !/^[a-f\d-]{36}$/i.test(v.id) || typeof v.revision !== 'string' || !/^[a-f\d-]{36}$/i.test(v.revision)
      || typeof v.salt !== 'string' || v.salt.length > 48 || decode(v.salt).length !== 32
      || typeof v.iv !== 'string' || v.iv.length > 20 || decode(v.iv).length !== 12
      || typeof v.ciphertext !== 'string' || v.ciphertext.length > 100_000 || decode(v.ciphertext).length < 16) throw new Error();
  } catch { throw new Error(t('The encrypted vault is damaged or uses an unsupported format. Your saved data has not been changed.')); }
  return v as EncryptedVault;
}
async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  if (password.length > 1024) throw new Error(t('The master password is too long. Use up to 1,024 characters.'));
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: decode(salt), iterations: KDF_ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { passwordBytes.fill(0); }
}
function validateKeys(value: unknown): ApiKeys {
  const keys = value as Partial<ApiKeys> | null;
  if (!keys || KEY_PROVIDERS.some(provider => typeof keys[provider] !== 'string' || keys[provider]!.length > 8192)) throw new Error(t('The vault contains invalid API key data.'));
  return Object.fromEntries(KEY_PROVIDERS.map(provider => [provider, keys[provider]!])) as ApiKeys;
}
export async function encryptKeys(key: CryptoKey, base: Pick<EncryptedVault, 'id' | 'salt'>, keys: ApiKeys): Promise<EncryptedVault> {
  const vault: EncryptedVault = { ...base, revision: crypto.randomUUID(), version: 1, kdf: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS, algorithm: 'AES-GCM-256', iv: encode(crypto.getRandomValues(new Uint8Array(12))), ciphertext: '' };
  const plain = new TextEncoder().encode(JSON.stringify({ version: 1, keys: validateKeys(keys) }));
  try {
    if (plain.byteLength > 60_000) throw new Error(t('The API keys are too large to save. Check the values and try again.'));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: decode(vault.iv), additionalData: additionalData(vault), tagLength: 128 }, key, plain);
    vault.ciphertext = encode(new Uint8Array(encrypted));
    return vault;
  } finally { plain.fill(0); }
}
export async function decryptKeys(key: CryptoKey, vault: EncryptedVault): Promise<ApiKeys> {
  validateVault(vault);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(vault.iv), additionalData: additionalData(vault), tagLength: 128 }, key, decode(vault.ciphertext)));
  try {
    const payload = JSON.parse(new TextDecoder().decode(plain));
    if (payload.version !== 1) throw new Error(t('The vault contains invalid API key data.'));
    return validateKeys(payload.keys);
  } finally { plain.fill(0); }
}
export async function createEncryptedVault(password: string, keys: ApiKeys) {
  validateMasterPassword(password);
  const salt = encode(crypto.getRandomValues(new Uint8Array(32)));
  const key = await deriveKey(password, salt);
  const vault = await encryptKeys(key, { id: crypto.randomUUID(), salt }, keys);
  return { key, vault };
}
export async function unlockEncryptedVault(password: string, value: unknown) {
  const vault = validateVault(value);
  const key = await deriveKey(password, vault.salt);
  try { return { key, keys: await decryptKeys(key, vault) }; }
  catch { throw new Error(t('The password is incorrect, or the vault has been damaged.')); }
}
