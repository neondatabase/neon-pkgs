---
"@neondatabase/ai-sdk-provider": patch
---

Align the model catalog with the models.dev `neon` provider. Model ids now use the canonical Neon (unprefixed) form — `claude-sonnet-4-6`, `gpt-5`, `gemini-2-5-flash` — instead of the `databricks-` prefix. This is backward compatible: routing and capability detection match on the id substring, and the legacy `databricks-` prefixed ids still resolve via the `(string & {})` fallback.

`NeonChatModelId` now covers the full models.dev `neon` catalog (incl. the Gemini 3 family: `gemini-3-pro`, `gemini-3-flash`, `gemini-3-1-pro`) plus gateway-served extras that models.dev does not list yet (Codex `gpt-5-*-codex`, `gpt-5-5-pro`, `gemini-3-5-flash`, `gemma-3-12b`, Llama, Qwen). The catalog is exported as `NEON_MODELS_DEV_IDS` / `NEON_EXTRA_MODEL_IDS`, and a maintainer-only drift check (`test:drift`, run weekly via the `catalog-drift` workflow) fails if the pinned models.dev list diverges from the live one.
