---
"@neon/ai-sdk-provider": patch
---

Stop sending sampling parameters that three newly added models reject.

The gateway added `kimi-k3`, `gemini-3-6-flash` and `gemini-3-5-flash-lite`, and all three
are stricter than the rules covering them. `kimi-k3` fell through to the permissive default
and `gemini-3-6-flash` inherited the Gemini rule, so setting `frequencyPenalty` or
`presencePenalty` on any of them — or `temperature` or `topP` on `gemini-3-6-flash` — sent a
parameter the gateway answers with `400`. Those are now dropped with a warning, the same way
every other unsupported parameter is handled.

The exceptions are listed by model id because nothing in the id predicts them:
`gemini-3-1-flash-lite` accepts penalties and `gemini-3-5-flash-lite` does not, so neither the
version nor the `-lite` suffix is the rule.

The penalty warning previously read "Only Gemini accepts penalties on the gateway's unified
endpoint", which is no longer true and read as a contradiction to the Gemini users now hitting
it. It now names the model instead of the family.
