---
"@neon/sdk": patch
---

`realtime.enable` with `waitForReadiness` now waits until the branch reports `enabled: true` as well as `pending: false`, so a read that still shows Realtime disabled no longer resolves as success.
