# AI provider setup

This document describes the current code in src/ai, not live service availability. Release verification uses Mock and injected HTTP responses.

## Subscription / local mode: Codex

CodexAdapter uses @openai/codex-sdk 0.156.0 and a local Codex CLI. Authenticate with `codex login` under the same OS user, then set AI_ADAPTER=codex. No OpenAI API key is required. Calls consume the user's Codex allowance.

CODEX_PATH optionally points to the native executable (on Windows, an .exe rather than a PowerShell shim); CODEX_MODEL optionally selects a model. The SDK inherits the process environment, including authentication context and HTTP_PROXY / HTTPS_PROXY / NO_PROXY. Never copy Codex auth files into this repository.

startThread/resumeThread cache IDs are role-specific and replaceable. Each call includes current framework context. An unusable saved thread is retried once with a fresh thread; this is not unlimited retry.

## API mode

| Adapter | Environment settings | Current code defaults |
|---|---|---|
| OpenAI | OPENAI_API_KEY, OPENAI_MODEL, OPENAI_BASE_URL, OPENAI_MAX_OUTPUT_TOKENS | https://api.openai.com/v1; gpt-5.6-luna; 12000 |
| DeepSeek | DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_BASE_URL, DEEPSEEK_MAX_OUTPUT_TOKENS | https://api.deepseek.com; deepseek-flash; 12000 |
| Responses-compatible | Configure key/base URL/model in the AI Provider dialog | No implicit defaults |

Select startup provider with AI_ADAPTER=openai or deepseek. Keys are required in the environment at startup; alternatively start in Mock/Codex and configure an API provider in the UI. Starting directly with responses-compatible is not supported by the environment-only startup wiring because its URL/key/model are supplied by the dialog.

All three adapters POST to `<base_url>/responses` with a Bearer key, input, and JSON Schema text.format. They parse structured output and the AI runtime validates it again. OpenAI requests strict schema output; the other adapters send their existing non-strict format. A service offering only /chat/completions needs a different adapter.

The names above are **code defaults**, not recommendations or guaranteed available models. Check the provider's actual capabilities and account access; no live OpenAI/DeepSeek calls are performed by the public-release test suite.

## Keys and trust

UI-entered keys live in the Node Provider Manager's in-memory configuration until process exit. The UI clears its key field after applying configuration. Keys are not included in public provider info, canonical saves, exports, or browser localStorage. Environment keys are read by the relevant adapter. Never commit a filled .env.

A compatible provider URL receives your key and game context: only use a provider you trust. Existing API errors may include upstream error text; review messages before sharing screenshots/logs.

## Proxies

Codex inherits environment settings. The API adapters use Node global fetch directly; they do not configure a custom proxy agent. Setting HTTP_PROXY/HTTPS_PROXY alone is not a universal guarantee that a given Node version routes fetch through that proxy. Configure and verify the networking behavior of your Node environment separately. NO_PROXY should include localhost and 127.0.0.1 when relevant.

## Offline and optional live verification

- `npm test`: Mock/injected-fetch tests, no real provider requests.
- `npm run smoke`: Mock app and generic example, no AI quota.
- `npm run smoke:codex`: explicit optional live Codex calls; uses allowance and may fail due to login/network/model availability.

Provider implementation references: [manager](../src/ai/providers.ts), [Codex](../src/ai/codex.ts), [OpenAI](../src/ai/openai.ts), [DeepSeek](../src/ai/deepseek.ts), [compatible](../src/ai/responses-compatible.ts).
