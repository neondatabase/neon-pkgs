---
"@neon/config": minor
"@neon/config-runtime": patch
"neon": patch
---

`neon deploy` no longer re-enables a trigger disabled with `neon triggers disable`, or turns on triggers a child branch inherits disabled, when `neon.ts` omits `enabled`. Set `enabled: true` or `enabled: false` to have every apply enforce that state. `neon config plan` and `neon deploy` now list each trigger field they change, for example `cron  0 3 * * * → */30 * * * *`. `ResolvedFunctionTrigger.enabled` is `undefined` when `neon.ts` omits it.
