---
"@neon/realtime": patch
---

Attempt to reconnect and restore live queries after a server-reported connection protocol error. If the same error recurs before the connection stabilizes, surface it as a terminal failure.
