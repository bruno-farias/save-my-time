# Contributing

Save My Time is MIT licensed. Translations and new languages are welcome through pull requests under the same [license](LICENSE).

## Add a language with one JSON file

Add `src/locales/languages/<code>.json`. Files in this directory are discovered automatically at build time. No registry, component, manifest, or prompt changes are required.

For example, a new AI output language could start with:

```json
{
  "$schema": "../schema.json",
  "code": "ca",
  "name": "Catalan",
  "nativeName": "Català",
  "direction": "ltr",
  "interface": false,
  "messages": {}
}
```

- `code` is a canonical BCP 47 tag, such as `ca`, `pt-BR`, or `zh-TW`. Match its spelling and capitalization in the filename. `auto` is reserved.
- `name` is the English name; `nativeName` appears in language pickers and identifies the output language in model instructions.
- `direction` is `ltr` or `rtl`. For interface languages it controls the document direction. Article and generated text detect their own direction.
- Every file adds an option for summaries and follow-up answers. Model language support and quality still depend on the provider; adding a file does not install a language model.
- Set `interface` to `true` and add translations to offer it under **Settings → Interface language** too. To translate an existing output-only language, edit its existing JSON file.

Use [en.json](src/locales/languages/en.json) as the complete message reference. Copy the exact English keys, translating only the values:

```json
"messages": {
  "Settings": "Configuració",
  "Master password": "Contrasenya mestra",
  "{provider} settings": "Configuració de {provider}",
  "~{count} words": "~{count} paraules"
}
```

Partial interface translations are accepted. Omit untranslated entries; they fall back to English. Preserve every named placeholder, such as `{provider}`, `{count}`, or `{origin}`, exactly. They may move within the sentence. Messages are plain text, not HTML or Markdown. Keep provider names, API identifiers, commands, and keyboard shortcuts unchanged. Do not put credentials or private article content in a contribution.

Run:

```sh
npm ci
npm run locales:check
npm run check
```

The checks validate filenames, metadata, known message keys, and placeholder parity. The build and CI run the locale check, so a JSON-only PR is sufficient. Test the interface using `npm run dev`, select the new interface language, and inspect narrow widths and both themes. When installed, reload the extension after rebuilding. Native browser permission prompts and provider-supplied error details keep their own language.

## Change interface wording

Wrap user-facing strings in `t('English source message')`. Use named placeholders instead of concatenating variable values. For labels stored in configuration and translated later, use `mark('English source message')` and call `t(label)` when rendering.

After changing source strings, run `npm run locales:sync` to regenerate **only** the English reference. Update or remove obsolete translated keys, then run `npm run locales:check`. Existing translations are never overwritten by the sync command. Prefer complete sentences to fragments so translators can change word order.

## Code changes

Keep all executable extension code bundled locally and use the existing provider boundary. Run `npm run check`; for provider changes, also use the local Postman HTTP fixtures via `npm run test:integration`. For settings, vault, or panel behavior, build and run `npm run test:e2e` in a disposable browser profile. See [verification](docs/verification.md) and [vault design](docs/vault.md).
