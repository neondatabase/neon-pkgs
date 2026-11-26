---
"@neon/config": patch
"neon": patch
---

`neon deploy` no longer reports a Realtime conflict on every run when `neon.ts` sets `allowedOrigins: ["*"]`. Neon stores `["*"]` as an empty list, and both allow every origin, so the two now count as the same setting.
