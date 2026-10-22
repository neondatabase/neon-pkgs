---
"@neon/realtime": minor
---

Support message fragmentation on neon.realtime.v2 protocol. Large rows (up to 4 MiB per row) are now delivered in fragments across WebSocket messages. The client offers both neon.realtime.v2 and neon.realtime.v1 protocols; fragment reassembly occurs automatically on negotiated v2 connections. A new terminal error code, `row_too_large`, indicates when a subscription exceeds the row size limit.
