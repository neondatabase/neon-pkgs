---
"@neon/realtime": minor
"@neon/realtime-react": minor
"@neon/realtime-tanstack": minor
"@neon/realtime-drizzle": minor
"@neon/realtime-kysely": minor
---

Require the Realtime v2 WebSocket protocol and add atomic ordered result patches
with sequential move operations. Core materialized subscriptions and React
preserve the server sequence. Raw consumers must handle the new move variant;
TanStack DB collections retain unordered keyed semantics and ignore moves.

Release these packages at the 0.2.0 compatibility boundary. Deploy a server that
accepts v2 before upgrading clients; the SDK does not fall back to v1. Upgrade
core and adapters together: the official adapters now require core ^0.2.0.
