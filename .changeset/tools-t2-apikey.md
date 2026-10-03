---
"@neon/tools": patch
---

A provided empty `apiKey` is rejected at `createNeonTools`. `{ apiKey: undefined }` on `execute` keeps the constructor credential.
