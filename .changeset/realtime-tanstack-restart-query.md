---
"@neon/realtime-tanstack": patch
---

Fix two collection lifecycle bugs.

- A collection that restarts after cleanup, or reloads, subscribes with the newest sealed query `refreshQuery` returned. It used to subscribe with the query it was created with, which had often expired by then, so the new run started with a rejected subscription and an extra `refreshQuery` call.
- `utils.awaitTxId()` waits for the collection to start syncing, within the same timeout, instead of throwing "Realtime collection is not syncing" when nothing has observed or preloaded the collection yet. It does not start synchronization itself. If subscription setup fails, pending and later waits reject with that failure instead of hanging.

The README now covers restarts and expired queries, and notes that TanStack DB apps don't need `RealtimeProvider`.
