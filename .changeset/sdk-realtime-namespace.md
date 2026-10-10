---
"@neon/sdk": minor
"@neon/tools": minor
---

Add `neon.realtime` with `get`, `enable`, `disable`, `secret`, and `rotateSecret` for branch Realtime. `enable` waits until the change is applied by default; `disable` and `rotateSecret` wait with `waitForReadiness: true`. `@neon/tools` publishes `realtime.get`, `realtime.enable`, `realtime.disable`, and `realtime.rotateSecret` as tools, which wait for the change; `realtime.secret` is not a tool.
