---
"@neon/ai-sdk-provider": minor
---

`neon.tools.imageGeneration()` now sends `gpt-image-2` when no `model` is given, and throws `UnsupportedFunctionalityError` for `gpt-image-1`, which OpenAI has deprecated.
