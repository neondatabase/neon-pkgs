---
"@neon/realtime": minor
---

Support message fragmentation on the neon.realtime.v3 protocol. Large rows (up to 4 MiB per row) are now delivered in fragments across WebSocket messages. v3 is v2 plus the `fragment` message and the `row_too_large` subscription error; the client offers neon.realtime.v3 and falls back to neon.realtime.v2, and reassembles fragments automatically on v3 connections. A new terminal error code, `row_too_large`, indicates when a subscription exceeds the row size limit. The active protocol schema is now v3; `@neon/realtime/schema/realtime-protocol-v2.schema.json` resolves to a frozen snapshot of v2.
