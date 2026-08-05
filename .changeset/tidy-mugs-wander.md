---
"neon": minor
---

Fix WebSockets under `neon dev`. The dev server registered no `'upgrade'` listener, so
Node handed a WebSocket handshake to the ordinary request handler and answered `200 OK` on
a connection the client expected to be a `101` — a function's `upgrade` export was never
called, and the failure looked like success.

The dev server now handles upgrades the way the deployed runtime does: the existing
`export function upgrade(req, socket, head)` shape works locally for the first time, and
`upgradeWebSocket()` from `@neon/functions` works too, with the same precedence (a legacy
`upgrade` export wins) and the same clean `501` for a function that serves no WebSockets.
