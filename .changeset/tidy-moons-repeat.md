---
"@neondatabase/ai-sdk-provider": minor
---

Fix hard 400s on sampling parameters, resync the model catalog, and remove the gateway-extras list.

**Fixes.** The capability rules claimed support the gateway does not have, so the provider forwarded parameters that come back as a `400` instead of stripping them with a warning:

- Claude 4.7 and newer (`claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`) reject `temperature` and `top_p` — those models are steered with `output_config.effort`. Claude 4.6 and earlier are unaffected and keep both.
- Every unified-endpoint family except Gemini rejects penalties (`parameter "frequency_penalty" must be equal to 0`). `gpt-oss`, Qwen, Gemma, `glm-5-2` and `inkling` now drop them. `gpt-oss` also rejects `seed` and `stop`; Qwen and Gemma reject `seed`.

**Catalog.** `NEON_MODELS_DEV_IDS` now covers all 39 models the gateway serves. The exported union gains `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `glm-5-2`, `gpt-5-5-pro`, `gpt-5-6-luna`, `gpt-5-6-sol`, `gpt-5-6-terra` and `inkling`, and loses `claude-sonnet-4`, `gemini-2-5-flash`, `gemini-2-5-pro`, `gemini-3-pro` and `gpt-5-2-codex`, which the gateway no longer serves. (`gpt-5-1-codex-max` and `gpt-5-1-codex-mini` were also retired upstream but were never in the union.)

**Breaking: `NEON_EXTRA_MODEL_IDS` is removed.** It existed to autocomplete ids the gateway served ahead of models.dev, and the two catalogs now agree. The concept is gone rather than shipped empty: such an id already works, since `NeonChatModelId` accepts any string via its `(string & {})` fallback. `NeonKnownModelId` is now `NEON_MODELS_DEV_IDS[number]`. If you imported `NEON_EXTRA_MODEL_IDS`, delete the import.

Model routing is unchanged.
