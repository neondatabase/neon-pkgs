---
"@neon/realtime": patch
---

Reset all subscription wire state before reconnect callbacks, so a state listener can safely unsubscribe another query during a disconnect.
