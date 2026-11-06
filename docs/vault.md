# API key vault

Starting with 0.3.0, saving cloud API keys requires a user-created master password. Ollama and Chrome AI can be used without creating a vault when no cloud keys are saved. A vault, once created, must be unlocked before entering the reader, even if the selected provider is local.

## User flow

When upgrading from plaintext settings, the panel asks the user to create and confirm a master password. Existing keys remain in their old record until migration succeeds. The panel does not use those keys before migration. **Encrypt saved keys** replaces that record with encrypted keys while preserving the selected provider, models, theme, and reading preferences. New users create their password in **Settings → API key protection** when saving their first API key.

A password must have at least 12 characters. Setup and password-change buttons stay disabled until the new password and confirmation match exactly; inline messages explain short or mismatched entries. Submission validates them again. Use a long, unique passphrase. The extension does not save the master password, keep a recovery copy, or send it to any provider. A password manager may save it if the user chooses.

Unlocking lasts for the current panel document. The panel locks after 15 minutes without keyboard, pointer, or wheel activity, when its document closes, or when **Lock vault** is selected. A manual lock also locks other open panels. Locking unmounts the reader and settings form, aborts active generation/catalog requests, and releases their credential references. JavaScript garbage collection does not guarantee immediate erasure of string copies from process memory.

**Change master password** requires the current password and encrypts the keys again with a new salt and key. Other open panels lock when the vault identity changes. **Forgot your master password?** offers an explicit confirmation to remove saved keys; it preserves other settings. The old password cannot be recovered. Resetting a vault does not revoke credentials at their providers.

## Cryptography and storage

The implementation uses the browser's Web Crypto API:

| Item | Implementation |
| --- | --- |
| Password derivation | PBKDF2-HMAC-SHA-256, 600,000 iterations, random 32-byte salt |
| Encryption | AES-256-GCM with a random 12-byte IV for every encryption and a 128-bit authentication tag |
| Authenticated metadata | Application identifier, vault format version, vault UUID, and per-write revision UUID |
| Derived key | Non-extractable `CryptoKey`, retained only in the current panel's module memory |
| Persistent data | One `chrome.storage.local.settings` record, version 2, with public preferences plus the ciphertext envelope |
| Stored secrets | OpenAI, Anthropic, and Gemini API keys, inside a single encrypted payload |

The password and derived key never enter `chrome.storage.local`, `chrome.storage.sync`, or `chrome.storage.session`. Saved provider settings have no `apiKey` property. Public provider names, model IDs, server addresses, interface language, output language, and theme remain readable. Encrypted credentials are never synced. `chrome.storage.local` is restricted to `TRUSTED_CONTEXTS`; content scripts cannot read it. API keys are decrypted in the panel for direct authenticated provider requests, including model discovery. The password does not appear in those requests.

PBKDF2 is available natively in Web Crypto; the iteration count follows the [OWASP PBKDF2-HMAC-SHA-256 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Authenticated encryption follows [OWASP cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) and the [Web Crypto AES-GCM specification](https://www.w3.org/TR/webcrypto/). Chrome documents storage access restrictions in its [Storage API reference](https://developer.chrome.com/docs/extensions/reference/api/storage).

No custom cryptographic primitive, remote library, embedded master key, or reversible password obfuscation is used. Password bytes and decrypted byte buffers are cleared after use where possible. The runtime must still hold JavaScript strings while a key is being edited or used.

## Writes, failures, and multiple panels

All writes replace one settings record. Migration never clears plaintext first or makes an intermediate plaintext copy elsewhere. If the storage write rejects, the old settings remain available for retry. Password rotation follows the same pattern. A malformed or unsupported encrypted envelope is shown as an error and is not silently overwritten.

Web Locks serialize reads used for credentials and all settings mutations across panels. Preference-only saves retain the latest encrypted keys. Key edits and password changes require the revision read by the settings form; stale forms must close and reopen settings to load the current revision. An in-memory lock counter prevents an asynchronous operation from restoring an unlocked session after locking. Storage-change notifications invalidate other panels on password rotation or reset.

## Scope of protection

This protects saved API keys in a copied browser settings record when the vault is locked and the password is strong. It does not protect against a compromised browser, malicious extension update, malware, or someone using developer tools while the vault is unlocked. A weak password can still be guessed offline. Previous plaintext backups, browser storage journals, and filesystem snapshots are not securely erased by migration.

The vault covers API keys. Article text and chat still use browser-session storage, without vault encryption; ordinary preferences are also outside the encrypted payload. Closing a panel does not delete its session chat. Browser restart, extension reload, tab closure, and navigation follow the existing session cleanup rules.

Actual Web Crypto tests exercise encryption, tampering, wrong passwords, unique salts/IVs, migration failures, rotation, lock races, concurrent forms, and reset. Browser tests inspect local and session storage after fake-key migration, exercise authenticated HTTP after unlocking, and test locking, reloads, and multiple panels. This testing is not an independent cryptographic audit. See [verification](verification.md).
