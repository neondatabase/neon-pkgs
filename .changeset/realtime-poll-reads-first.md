---
"@neon/sdk": patch
---

`neon.realtime` readiness polling reads the Realtime state immediately instead of after the first `pollIntervalMs`, so a `wait.timeoutMs` shorter than the interval no longer times out without checking.
