# Testing

Tests use fake credentials and disposable browser profiles. Provider integration tests run the real HTTP clients against local Postman fixtures; they do not contact live model providers.

## Run the checks

Install dependencies with `npm ci` using Node 24.15+ in the 24.x series.

| Command | Checks |
| --- | --- |
| `npm test` | Unit and regression tests. |
| `npm run test:coverage` | Unit tests with V8 coverage and enforced thresholds. |
| `npm run test:scripts` | Test-runner process cleanup, including descendants that ignore graceful termination. |
| `npm run check` | TypeScript, coverage, script tests, locale validation, and the production build. |
| `npm run test:integration` | Generation and model catalogs over real HTTP to local Postman simulations. |
| `npm run test:e2e` | Playwright tests of the preview and built extension, including native side-panel behavior. |
| `npm run test:mutation` | Stryker changes production logic and checks that the unit tests detect it. |

For HTTP and browser tests, install Postman CLI:

```sh
npm install --global postman-cli@1.73.0
npm run test:integration
npm run build
npx playwright install chromium
npm run test:e2e
```

No Postman account or provider key is needed for these local simulations. Browser tests require a fresh `dist/` build. On Linux, `npx playwright install --with-deps chromium` also installs browser system dependencies. To use an installed Brave binary, set `SMT_BROWSER_EXECUTABLE` as shown in the [README](../README.md).

## Coverage scope and gates

Coverage and mutation testing deliberately share the same nine core modules:

- Browser permissions, article reading, and session caching (`src/lib/browser.ts`).
- Credential persistence and concurrency (`src/lib/credential-store.ts`).
- Article extraction (`src/lib/extract.ts`).
- Source and conversation budgets, languages, and prompts (`src/lib/prompts.ts`).
- Settings normalization and provider connection boundaries (`src/lib/settings.ts`).
- Incremental UTF-8, line, and SSE decoding (`src/lib/streams.ts`).
- Password validation, authenticated encryption, and vault formats (`src/lib/vault-crypto.ts`).
- Language registration, fallback, interpolation, and contribution validation (`src/locales/catalog.ts` and `validation.ts`).

Each file must reach **95% statements, lines, and functions, and 85% branches**. These percentages describe the listed modules, not the entire extension. React screens, native toolbar interactions, and provider adapters have separate unit, HTTP, or browser checks; they are not included in the mutation score.

V8 reports are written to `coverage/`, including HTML, LCOV, and JSON summaries. See [Vitest coverage documentation](https://vitest.dev/guide/coverage.html).

## Mutation testing

```sh
npm run test:mutation
```

Stryker runs the unmodified tests first, then changes conditions, operators, strings, and blocks in the selected production modules. A detected mutation causes a test failure or timeout. A survivor means the tests did not distinguish that change; inspect it to decide whether it represents a missing assertion, an equivalent change, or an intentionally untested detail.

The command exits unsuccessfully below an **80% mutation score**, if a mutation causes a test-runner error, or if no mutations execute. Stryker normally excludes runner errors from its score; the wrapper rejects them so a passing percentage cannot conceal an incomplete run. Static mutants are included, all standard mutation operators remain enabled, and CI runs a complete pass rather than reusing an incremental score. Browser automation and live model inference are outside this run. The real Web Crypto implementation is used; PBKDF2 is not replaced with a cheap fake.

Reports are written to:

- `reports/mutation/mutation.html`: source-level results for review.
- `reports/mutation/mutation.json`: machine-readable results, including survivors and timeouts.

For a focused local run:

```sh
npm run test:mutation -- --mutate 'src/lib/streams.ts'
```

A focused score only describes that file. Run the full command before treating the overall gate as satisfied. Reports and Stryker's temporary sandboxes are ignored by Git.

Two tool compatibility details are documented in the configuration:

- TypeScript 7 does not expose the compiler API used by Stryker 10's tsconfig preprocessor. The empty `tsconfigFile` setting skips that rewrite; Vitest still reads the copied `tsconfig.json`. This project has no external `extends` or project references. Revisit the setting if those are introduced or Stryker fixes [its TypeScript 7 compatibility issue](https://github.com/stryker-mutator/stryker-js/issues/6110).
- The single `import.meta.glob` declaration is excluded from mutation because Vite requires compile-time literal arguments. Instrumenting them prevents even the unmodified test run from compiling. The registry's runtime sorting, filtering, fallback, and interpolation remain mutated.

See [Stryker's Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/) and [configuration reference](https://stryker-mutator.io/docs/stryker-js/configuration/).

## CI

The GitHub workflow runs three independent jobs on pushes and pull requests:

1. Build, unit tests, script tests, and coverage gates.
2. Postman HTTP integration tests and Chromium browser tests.
3. Mutation testing and its score gate.

Coverage, mutation reports, and browser/integration diagnostics are uploaded as workflow artifacts, including on failures when files are available. Review the [verification record](verification.md) for measured results and limits; local simulations do not establish provider billing, live inference quality, or Chrome AI model availability.
