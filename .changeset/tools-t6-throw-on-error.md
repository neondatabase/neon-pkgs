---
"@neon/tools": patch
---

`throwOnError: false` on `createNeonTools` returns `{ data } | { error }` from `execute` instead of throwing.
