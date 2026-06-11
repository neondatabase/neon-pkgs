---
"@neondatabase/ai-sdk-provider": minor
---

Implement the Neon AI Gateway provider (replaces the name-reservation placeholder).

`createNeon()` / `neon` now return a working Vercel AI SDK provider that routes each model to the best branch-scoped gateway endpoint based on its id:

- **Anthropic** (`databricks-claude-*`) → native Messages API (streaming structured output + native reasoning).
- **OpenAI** (`databricks-gpt-*`, `*-codex`) → native Responses API (unlocks Codex, which is only served natively; native reasoning; the image-generation tool).
- **Everything else** (Gemini, Llama, Qwen, gpt-oss, ...) → the unified, OpenAI-compatible MLflow endpoint. Gemini is routed here because its native gateway endpoint does not support streaming.

Routing is transparent (same base URL + token). The implementation reuses the official `@ai-sdk/anthropic` and `@ai-sdk/openai` model classes, with gateway-compatibility shims (`forceReasoning` for `gpt-5` so reasoning handling works despite the `databricks-` prefix; `toolStreaming: false` for Anthropic so streaming tool calls aren't rejected) and a JSON Schema `$schema` strip for the unified endpoint. MLflow-routed models drop parameters a backend rejects (e.g. penalties/`seed` for Llama, `reasoningEffort` for Gemini) with an AI SDK warning instead of failing.

Supports `generateText`, `streamText`, tool calling (single + multi-step + streaming), `generateObject`, `streamObject`, image (vision) input, and image generation via the OpenAI Responses `image_generation` tool (use `streamText`). Configure with `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`, or pass `baseURL` / `apiKey` to `createNeon`.
