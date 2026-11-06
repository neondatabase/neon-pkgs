---
"@neon/realtime": patch
---

Retire a connection when a subscription error interrupts an in-flight renewal so a late acknowledgement cannot fail replacement subscriptions. Preserve a new connection created by a failure callback.
