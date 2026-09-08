---
"@neon/sdk": minor
---

`NeonTimeoutError` is now the abstract base of `NeonRequestTimeoutError` (`source: "request"`) and `NeonWaitTimeoutError` (`source: "wait"`, plus `operations` for `neon.operations.waitFor`). `kind` remains `"timeout"`. Direct construction uses the subclasses.
