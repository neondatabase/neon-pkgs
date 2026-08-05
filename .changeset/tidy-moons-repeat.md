---
"@neondatabase/ai-sdk-provider": patch
---

Resync the model id autocomplete with the gateway and models.dev. Adds `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `glm-5-2`, `gpt-5-6-luna`, `gpt-5-6-sol`, `gpt-5-6-terra` and `inkling`, and moves `gpt-5-5` to the gateway-only list. Routing is unchanged: the new Claude and GPT ids already matched the existing prefix rules, and `glm-5-2` and `inkling` correctly fall through to the unified endpoint. Any id not listed still resolves through the `(string & {})` fallback, so this only affects editor autocomplete.
