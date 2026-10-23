---
"@neon/ai-sdk-provider": patch
---

The gpt-6 models now get the same Responses-route handling as gpt-5: `reasoningEffort` is sent instead of ignored, `temperature` and `topP` are dropped with a warning instead of returning a 400, and system messages use the `developer` role. `getNeonModelCapabilities()` now reports `temperature` and `topP` as unsupported for `gpt-5-5`, `gpt-5-6`, and `gpt-6` models.
