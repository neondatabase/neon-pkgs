---
"@neon/realtime": patch
---

Report the state of a client's shared connection. `client.getConnectionState()` returns `idle`, `connecting`, `connected`, `reconnecting`, `error`, or `closed`, and `client.onConnectionStateChange()` reports each transition, so an application can show that the connection is retrying or has failed without inferring it from every subscription. A listener that throws is logged as `connection_listener_failed`.

The README now covers Node.js clients: pass `ws` as `webSocketFactory` so the process can exit after `close()`, because Node's built-in WebSocket waits for the server to close the TCP connection and cannot be terminated. Node clients don't need to send an `Origin` header. The README and `awaitTxId()` reference also state its contract: it resolves once the subscription has applied a state that includes the transaction, whether or not the write changed the query's rows, and it waits through reconnects and renewals, so pass a timeout.
