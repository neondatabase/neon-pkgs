---
"@neon/realtime": patch
---

Retry service-unavailable subscription rejections up to three times using the existing per-query backoff and any server retry hint. Healthy subscriptions on the socket continue running.
