---
"@neon/ai-sdk-provider": patch
---

Support `gpt-oss-*` models on the unified endpoint. The Neon AI Gateway returns gpt-oss responses in a non-OpenAI-compliant "harmony" shape (`message.content` as an array of reasoning/text parts instead of a string), which caused `generateText`/`streamText` to fail with `AI_APICallError: Invalid JSON response`. The provider now normalizes this to the OpenAI Chat Completions contract (string `content` + `reasoning_content`) before validation, so gpt-oss works end-to-end and its reasoning is surfaced. The transform is a no-op for every already-compliant model.
