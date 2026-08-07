# @neon/ai-sdk-provider

## 0.9.0

### Minor Changes

- 640d20c: Stop sending sampling parameters that three newly added models reject.

  The gateway added `kimi-k3`, `gemini-3-6-flash` and `gemini-3-5-flash-lite`, and all three
  are stricter than the rules covering them. `kimi-k3` fell through to the permissive default
  and `gemini-3-6-flash` inherited the Gemini rule, so setting `frequencyPenalty` or
  `presencePenalty` on any of them — or `temperature` or `topP` on `gemini-3-6-flash` — sent a
  parameter the gateway answers with `400`. Those are now dropped with a warning, the same way
  every other unsupported parameter is handled.

  The exceptions are listed by model id because nothing in the id predicts them:
  `gemini-3-1-flash-lite` accepts penalties and `gemini-3-5-flash-lite` does not, so neither the
  version nor the `-lite` suffix is the rule. They are matched exactly rather than by prefix, so a
  future `gemini-3-6-flash-*` does not inherit a restriction nobody measured for it.

  `NEON_MODELS_DEV_IDS` gains the three ids, so they autocomplete.

  The penalty warning previously read "Only Gemini accepts penalties on the gateway's unified
  endpoint", which is no longer true and read as a contradiction to the Gemini users now hitting
  it. It now names the model instead of the family.

  Two further corrections found by review, both the same class of bug — a rule asserting the
  gateway lacks something it has:

  `gpt-5-5-pro` reads as version 5.5 to the minor-version rule, so
  `getNeonModelCapabilities('gpt-5-5-pro').supportsTemperature` answered `true`. The gateway
  rejects it — `/openai/v1/responses` returns `Unsupported parameter: 'temperature'`. The exported
  answer is now correct. This changes what the function reports, not what goes over the wire: the
  Responses route strips the parameter upstream, so those calls already succeeded.

  Gemini does take `reasoning_effort` — the gateway maps it onto Gemini's thinking config, and
  `minimal` versus `high` measurably changes how much the model reasons. The provider dropped it
  and warned that the model did not take it, so callers lost control over reasoning they were
  billed for regardless. `providerOptions.neon.reasoningEffort` now reaches the gateway on Gemini.

  `getNeonModelCapabilities` returns different answers as a result: `supportsPenalties` is now
  false for `kimi-k3`, `gemini-3-6-flash` and `gemini-3-5-flash-lite`; `supportsTemperature` and
  `supportsTopP` are false for `gemini-3-6-flash` and `gpt-5-5-pro`; and `supportsReasoningEffort`
  is true for every Gemini id. Anything branching on those values will see the change.

  The three warning strings now name a remedy rather than restating what the AI SDK already
  prints ahead of them, and the README's capability table is corrected — it claimed Gemini was the
  only unified family accepting penalties, which is the same false statement this changeset removes
  from the warning.

## 0.8.0

### Minor Changes

- ed169e8: Fix hard 400s on sampling parameters, resync the model catalog, and remove `NEON_EXTRA_MODEL_IDS`.

  **Fixes.** The capability rules claimed support the gateway does not have, so the provider forwarded parameters that come back as a `400` instead of stripping them with a warning:

  - Claude 4.7 and newer (`claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`) reject `temperature` and `top_p` — those models are steered with `output_config.effort`. Claude 4.6 and earlier are unaffected and keep both.
  - Every unified-endpoint family except Gemini rejects penalties (`parameter "frequency_penalty" must be equal to 0`). `gpt-oss`, Qwen, Gemma, `glm-5-2` and `inkling` now drop them. `gpt-oss` also rejects `seed` and `stop`; Qwen and Gemma reject `seed`.

  **Catalog.** `NEON_MODELS_DEV_IDS` now covers all 39 models the gateway serves. The exported `NeonKnownModelId` union gains eight ids — `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `glm-5-2`, `gpt-5-6-luna`, `gpt-5-6-sol`, `gpt-5-6-terra` and `inkling` — and loses five: `claude-sonnet-4`, `gemini-2-5-flash`, `gemini-2-5-pro`, `gemini-3-pro` and `gpt-5-2-codex`, which the gateway no longer serves.

  **`getNeonModelCapabilities` returns different answers.** It is exported, and `supportsTemperature`, `supportsPenalties`, `supportsSeed` and `supportsStopSequences` all change for part of the catalog as a result of the fixes above. If you branch on it, re-check your assumptions. The README now documents every rule under "Dropped call options".

  **Note on the retired ids.** Removing them from `NeonKnownModelId` cannot warn most callers: `neon("gemini-3-pro")` still type-checks through the `(string & {})` fallback and now fails at the gateway instead. Only an explicit `const id: NeonKnownModelId = "gemini-3-pro"` gets a compile error.

  **Breaking: `NEON_EXTRA_MODEL_IDS` is removed.** It existed to autocomplete ids the gateway served ahead of models.dev, and the two catalogs now agree. The concept is gone rather than shipped empty: such an id already works, since `NeonChatModelId` accepts any string via its `(string & {})` fallback. `NeonKnownModelId` is now `NEON_MODELS_DEV_IDS[number]`. If you imported `NEON_EXTRA_MODEL_IDS`, delete the import.

  Model routing is unchanged.

## 0.7.3

### Patch Changes

- 73a83a1: Send `store: false` on the Responses route, so OpenAI multi-turn tool flows stop failing with a gateway 502.

  The gateway serves the Responses API statelessly and keeps no items — a response comes back with `"store": false` even when the request never set it. Left to its default the AI SDK assumes OpenAI's stored-item semantics and replays earlier reasoning as `{ type: "item_reference", id }`, which nothing upstream can resolve, so the gateway answers `502 INTERNAL_ERROR`. It surfaced on the second step of a tool loop, after the first step had already succeeded. The provider now sends the flag, which makes the model inline the encrypted reasoning instead.

  `false` is the only value the gateway accepts, so `providerOptions.openai.store` set to `true` or `null` now throws `UnsupportedFunctionalityError` instead of making a round trip to earn a `400`. `previousResponseId` and `conversation` are refused for the same reason — nothing is stored for them to refer to. Any other `store` type is left to the shared provider-option schema (`z.boolean().nullish()`), which rejects it locally with a clearer type error. `undefined` still counts as unset.

  One consequence to know about: replaying a provider-executed tool result (`neon.tools.imageGeneration` and the other Responses built-ins) needs the stored-item reference this gateway cannot resolve, so the AI SDK omits those results on a later step and reports it in `result.warnings`. The alternative was the 502. Nothing throws — the model just generates a fresh image instead of editing the earlier one — so the README now shows passing the image back as input content.

  JSON gateway errors no longer reach the caller as a bare `Bad Request`, on any route. The gateway emits several envelopes depending on which layer rejected the request — its own OpenAI-shaped one, a flat `{ error_code, message }` from Databricks, and a `{ error_code, message }` whose `message` is an upstream error encoded as a JSON string — while each underlying model parses only its own dialect. Anything else was dropped and the reason stranded on `error.responseBody`. Every route now re-emits the reason in the dialect its model reads, so `error.message` carries the actual explanation. Callers matching on `error.message` will see different strings; the gateway's original body is still on `error.responseBody`. The Anthropic route is covered for the same reason, though it cannot be confirmed against a live gateway: that endpoint currently answers every request with a plain-text 404, so no JSON envelope can be observed on it.

  The e2e matrix covers that path again: OpenAI and Codex tool calling had been removed from it while the 502 stood, and the tool test now requires a follow-up step rather than accepting a single one. The matrix also skips a family the branch does not serve instead of failing on it, so a per-account catalog (no Anthropic ids today) no longer turns the suite red, and the drifted `gemini-2-5-flash` id is replaced by `gemini-3-flash`.

## 0.7.2

### Patch Changes

- ec97d62: Support both AI SDK 6 and AI SDK 7, with compatibility coverage for every model currently enabled by the Neon AI Gateway.

## 0.7.1

### Patch Changes

- 7463e28: Support `gpt-oss-*` models on the unified endpoint. The Neon AI Gateway returns gpt-oss responses in a non-OpenAI-compliant "harmony" shape (`message.content` as an array of reasoning/text parts instead of a string), which caused `generateText`/`streamText` to fail with `AI_APICallError: Invalid JSON response`. The provider now normalizes this to the OpenAI Chat Completions contract (string `content` + `reasoning_content`) before validation, so gpt-oss works end-to-end and its reasoning is surfaced. The transform is a no-op for every already-compliant model.

## 0.7.0

### Minor Changes

- d1e06fe: Route models through the Neon AI Gateway's cleaned-up top-level paths. `createNeon()` now targets `${NEON_AI_GATEWAY_BASE_URL}/v1` for unified Chat Completions, `/openai/v1` for the OpenAI Responses dialect (Codex, GPT-5), and `/anthropic/v1` for native Anthropic Messages — instead of the older `/ai-gateway/{mlflow,openai,anthropic}/v1` prefixes. Behavior is unchanged (the gateway serves both), verified end-to-end across Anthropic, OpenAI, Codex, Gemini, Llama, and the image-generation tool.

## 0.6.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

## 0.5.0

### Minor Changes

- Drop the `/v1` subpath export — import everything from the package root instead.

  `@neondatabase/env/v1`, `@neondatabase/functions/v1`, and `@neondatabase/ai-sdk-provider/v1` are no longer published. Use the package root (`@neondatabase/env`, `@neondatabase/functions`, `@neondatabase/ai-sdk-provider`), which already exposed the full surface. Versioned subpath exports remain only on `@neondatabase/config` and `@neondatabase/config-runtime`, where pinning a policy-schema major is meaningful.

- Widen the `@ai-sdk/*` dependencies from exact pins to caret ranges (`^`).

  The exact pins (e.g. `@ai-sdk/provider-utils@4.0.27`) forced a second copy of `@ai-sdk/provider-utils` alongside the one a consumer's `ai@^6` resolves, and the duplicate module-local `Schema`/`Tool` symbols broke `neon.tools.imageGeneration()` against `streamText()`. Caret ranges let the provider's `@ai-sdk/*` dedupe with the consumer's `ai`, so consumers no longer need a `@ai-sdk/provider-utils` `overrides`/`resolutions` workaround.

## 0.4.0

### Minor Changes

- 9ac4b73: Upgrade `@neondatabase/ai-sdk-provider` to the AI SDK v6 provider specification (v3 language models). Requires `ai@^6`.

## 0.2.0

### Minor Changes

- 3985571: Implement the Neon AI Gateway provider (replaces the name-reservation placeholder).

  `createNeon()` / `neon` now return a working Vercel AI SDK provider that routes each model to the best branch-scoped gateway endpoint based on its id:

  - **Anthropic** (`databricks-claude-*`) → native Messages API (streaming structured output + native reasoning).
  - **OpenAI** (`databricks-gpt-*`, `*-codex`) → native Responses API (unlocks Codex, which is only served natively; native reasoning; the image-generation tool).
  - **Everything else** (Gemini, Llama, Qwen, gpt-oss, ...) → the unified, OpenAI-compatible MLflow endpoint. Gemini is routed here because its native gateway endpoint does not support streaming.

  Routing is transparent (same base URL + token). The implementation reuses the official `@ai-sdk/anthropic` and `@ai-sdk/openai` model classes, with gateway-compatibility shims (`forceReasoning` for `gpt-5` so reasoning handling works despite the `databricks-` prefix; `toolStreaming: false` for Anthropic so streaming tool calls aren't rejected) and a JSON Schema `$schema` strip for the unified endpoint. MLflow-routed models drop parameters a backend rejects (e.g. penalties/`seed` for Llama, `reasoningEffort` for Gemini) with an AI SDK warning instead of failing.

  Supports `generateText`, `streamText`, tool calling (single + multi-step + streaming), `generateObject`, `streamObject`, image (vision) input, and image generation via the OpenAI Responses `image_generation` tool (use `streamText`). Configure with `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`, or pass `baseURL` / `apiKey` to `createNeon`.

### Patch Changes

- 350e1d7: Align the model catalog with the models.dev `neon` provider. Model ids now use the canonical Neon (unprefixed) form — `claude-sonnet-4-6`, `gpt-5`, `gemini-2-5-flash` — instead of the `databricks-` prefix. This is backward compatible: routing and capability detection match on the id substring, and the legacy `databricks-` prefixed ids still resolve via the `(string & {})` fallback.

  `NeonChatModelId` now covers the full models.dev `neon` catalog (incl. the Gemini 3 family: `gemini-3-pro`, `gemini-3-flash`, `gemini-3-1-pro`) plus gateway-served extras that models.dev does not list yet (Codex `gpt-5-*-codex`, `gpt-5-5-pro`, `gemini-3-5-flash`, `gemma-3-12b`, Llama, Qwen). The catalog is exported as `NEON_MODELS_DEV_IDS` / `NEON_EXTRA_MODEL_IDS`, and a maintainer-only drift check (`test:drift`, run weekly via the `catalog-drift` workflow) fails if the pinned models.dev list diverges from the live one.
