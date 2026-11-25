---
"@neon/realtime": patch
---

Recover when a WebSocket stops being open without reporting that it closed. Node's built-in WebSocket waits in that state until the server ends the TCP connection, which can take indefinitely.

- The heartbeat stopped probing as soon as a ping couldn't be sent, so the client stayed disconnected while every subscription still reported `live` with stale data. A ping that can't be sent now counts as unanswered, so the client retires the socket after the heartbeat's idle and timeout periods, 30 seconds by default, and reconnects with its usual backoff.
- A new subscription replaced such a socket without retiring it. The subscriptions that were already live were never resubscribed, so they kept stale data, and `awaitTxId()` on them could resolve for a transaction whose changes they never received. The client now retires the socket first, so every subscription resubscribes on the next one.
- While the client reports a lost connection, a subscription or renewal started from a `connecting` callback now joins the client's scheduled reconnect instead of opening a socket of its own.
