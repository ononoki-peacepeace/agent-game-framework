# DeepSeek adapter

See [AI_PROVIDERS.md](AI_PROVIDERS.md) for configuration, key handling, current code defaults, and compatibility limitations.

The existing adapter targets a Responses-style `/responses` endpoint with JSON Schema text.format. It does not implement Chat Completions. Verify that your selected endpoint/model supports this contract; public-release validation uses an injected HTTP response, not a real DeepSeek request.

Set AI_ADAPTER=deepseek and DEEPSEEK_API_KEY before starting, or configure the provider through the UI after starting in Mock/Codex. UI-supplied keys are held in server memory; they are not written to the Save Package.
