---
"@neon/realtime": patch
---

Close the WebSocket when a terminal subscription error leaves no active subscriptions. Other admissions and subscriptions continue on the shared connection, and an expired subscription can still renew later.
