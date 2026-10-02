---
"@neon/ai-sdk-provider": major
---

Add embedding support: `neon.embeddingModel("qwen3-embedding-0-6b")` (or `"gte-large-en"`) works with `embed()` and `embedMany()`, with `providerOptions.neon.dimensions` for shorter Qwen vectors.

Breaking: the `NEON_MODELS_DEV_IDS` runtime export is removed. Model ids stay typed through `NeonChatModelId`, `NeonKnownModelId`, and the new `NeonEmbeddingModelId`.
