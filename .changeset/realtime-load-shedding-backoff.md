---
"@neon/realtime": patch
---

Retry backend-unavailable admissions and upstream-cancelled subscriptions with shared exponential backoff and jitter. Preserve stale results and unaffected subscriptions while obtaining a fresh baseline, without changing the WebSocket protocol.
