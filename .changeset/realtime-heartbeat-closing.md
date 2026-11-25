---
"@neon/realtime": patch
---

Recover when a WebSocket stops being open without reporting that it closed. Node's built-in WebSocket waits in that state until the server ends the TCP connection, which can take indefinitely.

- The heartbeat stopped probing as soon as a ping couldn't be sent, so the client stayed disconnected while every subscription still reported `live` with stale data. A ping that can't be sent now counts as unanswered, so the client reconnects within the heartbeat's idle and timeout periods: 30 seconds by default.
- A new subscription replaced such a socket without retiring it. The subscriptions that were already live were never resubscribed, so they kept stale data, and `awaitTxId()` on them could resolve for a write they never showed. The client now retires the socket first, so every subscription resubscribes on the next one.
