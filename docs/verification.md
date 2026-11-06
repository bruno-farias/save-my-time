# Verification record

Version 0.3.1 and its expanded test suite checked on 2026-11-06, using Node 24.19.0, Postman CLI 1.73.0, Vitest 5.1.0, and Stryker 10.1.1.

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm run typecheck` | Passed | Application, provider, extension, and test code type-checks. |
| Unit tests (`npm run test:coverage`) | 266 passed | Settings and URL boundaries, article sanitization and metadata, context limits, stream cleanup and framing, browser permissions and cache races, actual Web Crypto operations, vault formats and transitions, and language validation/fallback. |
| Core V8 coverage | 100% statements, branches, functions, and lines | The nine modules listed in [testing](testing.md). Per-file gates require 95% statements/lines/functions and 85% branches. This is not whole-extension coverage. |
| Stryker mutation tests | 90.23% passed | 1,187 executed mutants: 1,059 killed, 12 timed out, and 116 survived. No uncovered mutants or runner errors. Four compile-time glob mutants are explicitly ignored. The 80% gate and nonempty/error-free run guards passed. |
| `npm run locales:check` | Passed | 32 output languages, 4 interface languages, and 261 translated messages per initial interface. New JSON files require no registration code. |
| `npm run test:integration` | 83 passed | 45 generation and 38 model-catalog cases using real HTTP against local Postman fixtures. Catalog coverage includes auth, pagination, filtering, empty/invalid responses, rate limits, redirects, repeated cursors, and abort. All four members appear in the simulation log. |
| Chromium browser tests | 9 passed | The development preview and packaged extension run in Chromium. The extension reads a real tab, sends article context in summaries and follow-ups, isolates keys from content scripts, cancels work, handles navigation, restores per-tab chat, and cleans up closed-tab sessions. Additional cases cover model/settings behavior, themes, missing article access, vault migration/unlock/rotation/reset, cross-panel locks, stale settings recovery, idle and resumed-document locks, and independent interface/output language persistence. |
| Same browser cases with installed Brave | 9 passed | The same 9 cases pass in Brave, including inline password validation and native side-panel toggling. |
| Build + `node scripts/package.mjs` | Passed | `dist/` and `release/save-my-time.zip` are produced. |
| ZIP integrity check | Passed | The archive has a root manifest, background and content bundles, panel HTML/CSS/JS, and all four icon sizes. |
| Production bundle inspection | Passed | No sample article, fake responses, or fixture credentials are present in production JavaScript. |
| `npm audit --omit=dev` | No known production dependency vulnerabilities reported | Audit result at implementation time; this is not a general security guarantee. |

Headless browser cases use disposable profiles. HTTP workflow cases add only their fixture and provider origins to a temporary manifest, routing every cloud catalog call to the local Postman simulation. A separate test uses the unchanged production manifest with a configured fake key to verify missing article access, the panel's permission action, no provider calls before generation, and protected-page handling. Native permission approval is not simulated as successful.

Vault browser cases use only fake keys. After migration, both local and session storage were inspected to confirm the fake API keys and test master passwords were absent from stored JSON. Unlocked credentials successfully authenticated model catalogs and generation against the local fixtures. Wrong passwords and failed saves preserved the prior vault. Rotation locked other panels; stale forms recovered by reopening settings; manual, idle, resumed-document, and document-reopen locks were checked. A reset retained preferences while deleting the vault. Portuguese, Spanish, and Italian previews, saved Portuguese UI, a Swedish output instruction, dark mode, and 320–600 px layouts were exercised. These establish client behavior, not live model translation quality.

The user's installed profile was not migrated by automation. The user must reload the rebuilt extension and choose a master password locally. Existing plaintext keys are encrypted only when that setup succeeds. New screenshots were inspected for the translated settings and dark vault screen.

Version 0.3.1 validation also covers empty fields, matching 11-character passwords, the 12-character boundary, mismatches, changing either entry after a match, first-time setup in settings, and password changes. Buttons remain disabled until valid; a programmatic submit with mismatched values still leaves legacy storage untouched.

The toolbar case uses a real user click on a test-only extension page to invoke the exact registered action listener; headless browsers do not dispatch the native toolbar accelerator. The remaining path uses the browser's real side-panel APIs. It verifies open/close/reopen, a browser-initiated close, two independent windows, and the `window.close()` fallback with `sidePanel.close` hidden. No test relay is included in `dist/` or the release ZIP. A physical toolbar click was not repeated in the user's profile for 0.3.1.

Chrome can report `windowId: -1` for side-panel contexts and omit the sender's document ID. Each native panel registers a random URL fragment and its window in session storage; every toggle checks that the registered URL still belongs to a live side-panel context. Both context and storage lookups start within the click, preserving the gesture needed by the open call. API contracts: [Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [runtime.getContexts](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts).

Earlier manual native verification of **0.2.0** in the installed Brave profile on 2026-11-06:

- Reloaded the existing extension to 0.2.0, preserving saved settings.
- Clicked the toolbar icon on the previously blocked Diário do Tocantins article. The panel extracted 647 words and displayed **Ready** with an enabled summary button.
- Opened settings with the existing OpenAI configuration. A live catalog request returned **53 available models**, preserving the selected model. No key value was displayed, copied, logged, or added to this repository.
- Visually inspected dark welcome, chat, and settings screenshots from the automated fixtures, including native input/select styling and narrow widths.

The browser window changed before the planned live summary click could run; the tool rejected that stale action and no further action was sent to the new page.

Live inference was not run. The OpenAI catalog check establishes live model-list authentication and browser connectivity for the configured account only. The remaining provider catalogs were tested with HTTP fixtures. These checks do not establish inference quality, generation endpoint compatibility for every catalog entry, real quota/billing, or actual model-download behavior. Chrome AI tests use capability fixtures, and unsupported browsers receive an explicit error rather than a cloud fallback.

The GitHub workflow runs coverage/build, HTTP/browser, and mutation jobs on pushes and pull requests. Reports are uploaded as artifacts. Remote results are available in [GitHub Actions](https://github.com/bruno-farias/save-my-time/actions). No browser-store publication was performed.

Postman CLI 1.73.0 differs from its installed skill in two places: `postman status` is an unknown command, and simulation mock paths need the explicit `config.yaml` file instead of the mock directory. The local simulation uses the working file form. All fixtures and evidence remain local; guest workspace bindings and generated skills are ignored by Git.

The test expansion found two regressions and added failing cases before fixing them: an oversized stream record ending in a newline could bypass the size guard, and UTF-8 context truncation could delete a complete replacement character already present in the article. Provider wire contracts remain unchanged. The 83-case HTTP rerun recorded 19 Ollama, 19 OpenAI, 22 Claude, and 23 Gemini requests; all nine browser cases passed in Chromium and Brave after the fixes.

The mutation command rejects runner errors and empty runs, in addition to enforcing its score threshold. A deliberately empty line-range selection was verified to exit unsuccessfully. A short test-name fix removed runner failures caused by embedding a very large invalid-vault fixture in a parameterized test name. Stryker dependencies are unmodified; configuration compatibility notes and the single compile-time glob exclusion are in [testing](testing.md).

The final mutation report retains all 116 survivors for review; no blanket mutation operators or static mutants were excluded to increase the score. The score covers the nine modules in `stryker.config.json`, with a full run taking approximately 2 minutes 20 seconds on the local machine. HTML and JSON reports are generated under `reports/mutation/` and uploaded by CI.
