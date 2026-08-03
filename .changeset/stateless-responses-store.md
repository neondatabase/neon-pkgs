---
"@neon/ai-sdk-provider": patch
---

Send `store: false` on the Responses route, so OpenAI multi-turn tool flows stop failing with a gateway 502.

The gateway serves the Responses API statelessly and keeps no items — a response comes back with `"store": false` even when the request never set it. Left to its default the AI SDK assumes OpenAI's stored-item semantics and replays earlier reasoning as `{ type: "item_reference", id }`, which nothing upstream can resolve, so the gateway answers `502 INTERNAL_ERROR`. It surfaced on the second step of a tool loop, after the first step had already succeeded. The provider now sends the flag, which makes the model inline the encrypted reasoning instead.

`false` is the only value the gateway accepts, so `providerOptions.openai.store` set to `true` or `null` now throws `UnsupportedFunctionalityError` instead of making a round trip to earn a `400`. Any other type is left to the shared provider-option schema (`z.boolean().nullish()`), which rejects it locally with a clearer type error. `undefined` still counts as unset.

JSON gateway errors no longer reach the caller as a bare `Bad Request`, on any route. The gateway emits several envelopes depending on which layer rejected the request — its own OpenAI-shaped one, a flat `{ error_code, message }` from Databricks, and a `{ error_code, message }` whose `message` is an upstream error encoded as a JSON string — while each underlying model parses only its own dialect. Anything else was dropped and the reason stranded on `error.responseBody`. Every route now re-emits the reason in the dialect its model reads, so `error.message` carries the actual explanation. The Anthropic route is covered for the same reason, though it cannot be confirmed against a live gateway: that endpoint currently answers every request with a plain-text 404, so no JSON envelope can be observed on it.

The e2e matrix covers that path again: OpenAI and Codex tool calling had been removed from it while the 502 stood, and the tool test now requires a follow-up step rather than accepting a single one. The matrix also skips a family the branch does not serve instead of failing on it, so a per-account catalog (no Anthropic ids today) no longer turns the suite red, and the drifted `gemini-2-5-flash` id is replaced by `gemini-3-flash`.
