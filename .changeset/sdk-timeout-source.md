---
"@neon/sdk": minor
---

`NeonTimeoutError` now has `source` (`"request"` when the API call exceeded `requestTimeoutMs`, `"wait"` when readiness polling exceeded `timeoutMs`) and `timeoutMs` (the budget that was exceeded). `kind` remains `"timeout"`. Direct construction requires `{ source, timeoutMs }`.
