---
"@neon/ai-sdk-provider": minor
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
version nor the `-lite` suffix is the rule. They are matched exactly rather than by prefix, so a
future `gemini-3-6-flash-*` does not inherit a restriction nobody measured for it.

`NEON_MODELS_DEV_IDS` gains the three ids, so they autocomplete.

The penalty warning previously read "Only Gemini accepts penalties on the gateway's unified
endpoint", which is no longer true and read as a contradiction to the Gemini users now hitting
it. It now names the model instead of the family.

Two further corrections found by review, both the same class of bug — a rule asserting the
gateway lacks something it has:

`gpt-5-5-pro` reads as version 5.5 to the minor-version rule and was told it accepts
`temperature` and `topP`. It does not; the Responses API answers `Unsupported parameter`.
It is now excluded, so the call succeeds with the parameter dropped instead of returning 400.

Gemini does take `reasoning_effort` — the gateway maps it onto Gemini's thinking config, and
`minimal` versus `high` measurably changes how much the model reasons. The provider dropped it
and warned that the model did not take it, so callers lost control over reasoning they were
billed for regardless. `providerOptions.neon.reasoningEffort` now reaches the gateway on Gemini.

`getNeonModelCapabilities` returns different answers as a result: `supportsPenalties` is now
false for `kimi-k3`, `gemini-3-6-flash` and `gemini-3-5-flash-lite`; `supportsTemperature` and
`supportsTopP` are false for `gemini-3-6-flash` and `gpt-5-5-pro`; and `supportsReasoningEffort`
is true for every Gemini id. Anything branching on those values will see the change.

The three warning strings now name a remedy rather than restating what the AI SDK already
prints ahead of them, and the README's capability table is corrected — it claimed Gemini was the
only unified family accepting penalties, which is the same false statement this changeset removes
from the warning.
