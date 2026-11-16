---
"@neon/tools": minor
---

Add `@neon/tools/effect`: `toEffectTools` runs Neon tools as Effects with tagged errors (`NeonToolInputError`, `NeonSqlError`, `NeonSqlConnectionError`, and `@neon/effect`'s SDK errors), interruption that cancels the call, a span per tool, and opt-in retries such as `retryReadOnlyNetworkFailures`. `effect` and `@neon/effect` are optional peer dependencies.
