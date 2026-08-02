---
"@neon/ai-sdk-provider": patch
---

Send `store: false` on the Responses route, so OpenAI multi-turn tool flows stop failing with a gateway 502.

The gateway serves the Responses API statelessly and keeps no items — a response comes back with `"store": false` even when the request never set it. Left to its default the AI SDK assumes OpenAI's stored-item semantics and replays earlier reasoning as `{ type: "item_reference", id }`, which nothing upstream can resolve, so the gateway answers `502 INTERNAL_ERROR`. It surfaced on the second step of a tool loop, after the first step had already succeeded. The provider now defaults the flag, which makes the model inline the encrypted reasoning instead; pass `providerOptions.openai.store` to override.

The e2e matrix covers that path again: OpenAI and Codex tool calling had been removed from it while the 502 stood, and the tool test now requires a follow-up step rather than accepting a single one. The matrix also skips a family the branch does not serve instead of failing on it, so a per-account catalog (no Anthropic ids today) no longer turns the suite red, and the drifted `gemini-2-5-flash` id is replaced by `gemini-3-flash`.
