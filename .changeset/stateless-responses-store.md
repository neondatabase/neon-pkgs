---
"@neon/ai-sdk-provider": patch
---

Send `store: false` on the Responses route, so OpenAI multi-turn tool flows stop failing with a gateway 502.

The gateway serves the Responses API statelessly and keeps no items — a response comes back with `"store": false` even when the request never set it. Left to its default the AI SDK assumes OpenAI's stored-item semantics and replays earlier reasoning as `{ type: "item_reference", id }`, which nothing upstream can resolve, so the gateway answers `502 INTERNAL_ERROR`. It surfaced on the second step of a tool loop, after the first step had already succeeded. The provider now sends the flag, which makes the model inline the encrypted reasoning instead.

`false` is the only value the gateway accepts, so an explicit `providerOptions.openai.store` that is anything else now throws `UnsupportedFunctionalityError` instead of making a round trip to earn a `400`. `undefined` still counts as unset.

Databricks error envelopes on the Responses route no longer reach the caller as a bare `Bad Request`. The gateway returns `{ error_code, message }` there — sometimes with an OpenAI error nested inside `message` as a JSON string — neither of which `@ai-sdk/openai` can parse, so the reason was stranded on `error.responseBody`. Both shapes are now mapped to the envelope the SDK reads, and `error.message` carries the actual explanation.

The e2e matrix covers that path again: OpenAI and Codex tool calling had been removed from it while the 502 stood, and the tool test now requires a follow-up step rather than accepting a single one. The matrix also skips a family the branch does not serve instead of failing on it, so a per-account catalog (no Anthropic ids today) no longer turns the suite red, and the drifted `gemini-2-5-flash` id is replaced by `gemini-3-flash`.
