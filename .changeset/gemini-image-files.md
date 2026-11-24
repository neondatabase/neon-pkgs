---
"@neon/ai-sdk-provider": minor
---

`generateText` and `streamText` return the images `gemini-3-pro-image` and `gemini-3-1-flash-image` generate in `result.files`, and `streamText` emits each one as a `file` part. Before, the provider dropped the image and returned an empty response.
