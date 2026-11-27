---
"@neon/realtime": patch
---

Reconnect when a socket never becomes ready, and fail unanswered subscription requests without interrupting other live queries on the socket.
