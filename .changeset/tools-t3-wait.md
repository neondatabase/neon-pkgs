---
"@neon/tools": patch
---

`wait: false` on `createNeonTools` skips readiness polling so a host can return immediately with `operations`.
