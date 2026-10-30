---
"@neon/tools": patch
---

`throwOnError: false` on `createNeonTools` and `createNeonTool` returns `{ data } | { error }` from `execute` instead of throwing.
