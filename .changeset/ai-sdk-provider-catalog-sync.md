---
"@neon/ai-sdk-provider": minor
---

Typed model autocomplete now follows [neon.com/models](https://neon.com/models), adding `claude-haiku-5-5`, `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-1-sol`, `gemini-3-7-flash`, `gemini-3-8-flash`, `gemini-4-argon`, `glm-5-3`, `grok-4-7`, and `deepseek-v4-1-flash`, plus `bge-large-en` for `neon.embeddingModel()`.

The provider no longer sends parameters these models reject: `temperature`, `topP`, and penalties for `gemini-3-7-flash`, `gemini-3-8-flash`, and `gemini-4-argon`, and penalties for Grok and DeepSeek models.
