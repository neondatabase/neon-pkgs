---
"@neondatabase/ai-sdk-provider": minor
---

Resync the model id autocomplete with the gateway catalog, and drop the gateway-extras list.

`NEON_MODELS_DEV_IDS` now covers all 39 models the gateway serves: adds `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `glm-5-2`, `gpt-5-5-pro`, `gpt-5-6-luna`, `gpt-5-6-sol`, `gpt-5-6-terra` and `inkling`, and drops `claude-sonnet-4`, `gemini-2-5-flash`, `gemini-2-5-pro`, `gemini-3-pro`, `gpt-5-1-codex-max`, `gpt-5-1-codex-mini` and `gpt-5-2-codex`, which the gateway no longer serves.

**Breaking: `NEON_EXTRA_MODEL_IDS` is removed.** It existed to autocomplete ids the gateway served ahead of models.dev, and is now empty because the two catalogs agree. Rather than ship an empty array, the concept is gone: such an id already works, since `NeonChatModelId` accepts any string via its `(string & {})` fallback, so the list only ever bought autocomplete for a few days at the cost of a surface that silently rots. `NeonKnownModelId` is now just `NEON_MODELS_DEV_IDS[number]`.

If you imported `NEON_EXTRA_MODEL_IDS`, delete the import — it was always empty or near-empty, and every id in it is either in `NEON_MODELS_DEV_IDS` now or no longer served. Model routing is unchanged.
