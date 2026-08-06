---
"neon": patch
---

Fix WebSocket serving under `neon dev`.

- A function can now refuse a handshake by returning an ordinary `Response`. A `401`,
  `403` or `404` returned from `fetch` is relayed to the client with its status, headers
  and body intact, instead of being replaced by `501 websocket not supported by this
  function`. Refusing an unauthenticated connection is the normal case for a WebSocket
  endpoint and there was previously no way to express it.
- `CloseEvent` is only a Node global from v23, and this package supports Node >= 20.19,
  so every close path threw `ReferenceError: CloseEvent is not defined` on Node 20 and
  22. It is now shimmed, alongside the existing `ErrorEvent` shim.
- A malformed handshake is answered as the client error it is: an unsupported
  `Sec-WebSocket-Version` gets `426` with `Sec-WebSocket-Version: 13`, a
  `Sec-WebSocket-Key` that is not a base64-encoded 16-byte value gets `400`, and a
  non-`GET` handshake gets `405`. Previously all three reached the handler, threw, and
  were reported as `502 handler error`.
- A flood of empty continuation frames no longer grows the reassembly buffer without
  bound; they add no bytes, so the byte ceiling never stopped them.
- When the peer never answers a close, the close event now reports `1006` rather than
  the code this side sent.
