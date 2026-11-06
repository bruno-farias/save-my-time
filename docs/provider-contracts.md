# Provider contracts

The extension calls providers directly from its side panel. It has no proxy, account system, telemetry, remote code, or bundled API credentials. Model names are editable because model availability depends on the user's account and changes over time.

| Provider | Request | Authentication | Stream |
| --- | --- | --- | --- |
| Ollama | `POST {server}/api/chat`, `model`, `messages` with a system turn, `stream: true`, runtime `options` | None for local server | NDJSON: `message.content`; terminal `done: true`; `error` can occur in-stream |
| OpenAI | `POST https://api.openai.com/v1/chat/completions`, `model`, `messages`, `stream: true`, `max_completion_tokens` | `Authorization: Bearer <key>` | SSE: `choices[0].delta.content`; terminal `[DONE]`; check `finish_reason` |
| Claude | `POST https://api.anthropic.com/v1/messages`, `model`, `system`, alternating `messages`, `max_tokens`, `stream: true` | `x-api-key`, `anthropic-version: 2023-06-01`, browser opt-in header | SSE: `content_block_delta` / `text_delta`; terminal `message_stop`; check `error` and `stop_reason` |
| Gemini | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`, `systemInstruction`, `contents` with `user`/`model` roles, `generationConfig` | `x-goog-api-key` header; never a key in the URL | SSE: `candidates[0].content.parts[].text` excluding thought parts; terminal `finishReason`; check blocked/empty output |

Only Ollama's server URL is configurable in the UI. Cloud keys only go to their fixed provider host. Requests omit cookies and reject redirects. Host permission is requested for the selected provider when the user saves settings or clicks Connect and load models. Within settings, model metadata loads automatically for the selected provider once permission exists. Reading a webpage does not automatically call a provider.

Article text is untrusted data, separate from the system instructions. The prompt requests grounded answers and explicitly says to disregard instructions in the article. No tools, actions, HTML execution, or remote images are enabled. Prompt wording is defense in depth, not a guarantee that a model will ignore every prompt injection.

Responses stream incrementally, support cancellation, and use a finite total timeout. An HTTP error, missing completion marker, refusal, truncated generation, or malformed stream is shown as an error, retaining any partial answer with an incomplete status. There are no automatic retries that could create additional charges.

The full extracted article is retained only in session storage, capped at extraction time. Requests apply smaller byte budgets for local models, preserve source context on follow-ups, and report when article context or earlier conversation was shortened. Length settings are prompt targets, not exact word-count guarantees. A selected output language requests a translated summary and answers; this is not full-page translation.

## Model discovery

| Provider | List endpoint | Pagination and filtering |
| --- | --- | --- |
| Ollama | `GET {server}/api/tags` | `models[].name`; installed models, no capability filter |
| OpenAI | `GET /v1/models` | `data[].id`; no pagination; exclude recognizable embedding/audio/image/moderation/legacy completion families |
| Claude | `GET /v1/models?limit=1000` | `data[].id`, `display_name`; follow `has_more` / `last_id` with `after_id` |
| Gemini | `GET /v1beta/models?pageSize=1000` | Follow `nextPageToken` with `pageToken`; use `models[].name` without the `models/` prefix and require `generateContent` in `supportedGenerationMethods` |

List calls use the same authentication headers and fixed cloud hosts as generation. No article text is sent. Each settings lookup has a 15-second total timeout, aborts when the provider/key/server changes or settings close, and ignores stale results. No automatic retries occur. Catalogs are deduplicated, sorted, and held in panel memory; model changes do not refetch them. Pagination stays on the original provider URL, detects repeated cursors, and has a finite page bound. HTTP/auth/quota/connection errors remain separate from a legitimate empty result; upstream error bodies are not rendered.

Catalog membership does not guarantee billing, regional availability, or compatibility with the generation endpoint. OpenAI returns no endpoint capability field, so unknown model IDs remain visible and manual entry is always available. Listing never overwrites the selected model. Chrome AI uses its browser-managed model without a remote list.

Sources: [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list), [Claude models](https://platform.claude.com/docs/en/api/models/list), [Gemini models](https://aistudio.google.com/api-reference/models/list-models), [Ollama tags](https://docs.ollama.com/api/tags). Orbit's Gemini example uses a query key; this implementation uses Google's documented [API-key header](https://docs.cloud.google.com/docs/authentication/api-keys-use) to keep credentials out of URLs.

## Article access

The toolbar action explicitly opens the native side panel and notifies it to retry reading under the new `activeTab` grant. Opening the panel without that grant exposes an **Allow access to this page** action. If the URL is visible, it requests only that site's HTTP(S) origin; otherwise Chrome 133+ can [request host access by tab ID](https://developer.chrome.com/docs/extensions/reference/api/permissions#method-addHostAccessRequest). On approval the panel rereads the page. Unsupported implementations fall back to a toolbar/shortcut instruction. Navigation cancels the pending state. Protected browser pages are distinguished from grantable websites. Provider and article permissions remain separate.

## Chrome AI

The fifth provider has no HTTP endpoint or API key. It uses `Summarizer` (`key-points`, Markdown, short/medium/long) for summaries and `LanguageModel` with a separate system instruction and full bounded source for follow-ups. `availability()` is checked for the requested language combination. Explicit setup starts model downloads from a user gesture, monitors progress, and releases prepared sessions. Requests are cancellable and always destroy their model session afterward. Context accounting supports both current and older extension API property names. Unsupported browsers, hardware, language pairs, or context quotas produce an error; the extension never switches to a remote provider automatically.

Sources: [Chrome Summarizer](https://developer.chrome.com/docs/ai/summarizer-api), [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api).

## Sources checked during implementation

- [Ollama chat](https://docs.ollama.com/api/chat), [streaming](https://docs.ollama.com/api/streaming), [extension origins](https://docs.ollama.com/faq).
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
- [Claude Messages](https://platform.claude.com/docs/en/api/messages), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
- [Gemini text generation](https://ai.google.dev/gemini-api/docs/text-generation), [generateContent](https://ai.google.dev/api/generate-content).
- [Chrome side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

Postman Orbit was consulted for public API discovery. Its OpenAI and Anthropic endpoints informed the contract; first-party docs are authoritative for the implemented subset. The Postman CLI runs as a guest, so an owner-workspace mock search was skipped. The installed CLI (1.73.0) does not implement the skill's `postman status` command. Local simulations validate this client against documented fixtures, not live accounts or model output quality.
