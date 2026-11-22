---
"@neon/realtime": patch
---

Keep reconnect backoff when live queries subscribe during an outage. Use a fixed WebSocket close reason so long server error messages cannot interrupt recovery.
