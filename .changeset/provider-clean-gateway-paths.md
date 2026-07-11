---
"@neon/ai-sdk-provider": minor
---

Route models through the Neon AI Gateway's cleaned-up top-level paths. `createNeon()` now targets `${NEON_AI_GATEWAY_BASE_URL}/v1` for unified Chat Completions, `/openai/v1` for the OpenAI Responses dialect (Codex, GPT-5), and `/anthropic/v1` for native Anthropic Messages — instead of the older `/ai-gateway/{mlflow,openai,anthropic}/v1` prefixes. Behavior is unchanged (the gateway serves both), verified end-to-end across Anthropic, OpenAI, Codex, Gemini, Llama, and the image-generation tool.
