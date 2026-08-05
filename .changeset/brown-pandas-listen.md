---
"@neon/functions": minor
---

Add `upgradeWebSocket(request, options?)` for serving WebSockets from a `fetch` handler.

Returns `{ socket, response }`, mirroring `Deno.upgradeWebSocket`: `socket` is a standard
`WebSocket`, and returning `response` from your handler completes the upgrade and opens it.
No extra export and no `ws` dependency needed — the existing
`export function upgrade(req, socket, head)` shape keeps working unchanged.

Requires a runtime that provides the upgrade (deployed, or locally under `neon dev`); on an
older runtime it throws a clear `TypeError` rather than misbehaving.
