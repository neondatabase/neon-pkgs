---
"@neon/realtime": minor
"@neon/realtime-react": minor
"@neon/realtime-tanstack": minor
"@neon/realtime-drizzle": minor
"@neon/realtime-kysely": minor
---

Preserve server order in core materialized subscriptions and React, including
incremental row moves, without changing `subscribe()` or `useLiveQuery()` call
signatures. Validate ordered patches before installing materialized results, and
expose a baseline plus its queued updates as one materialized snapshot.

This is a breaking upgrade at the 0.2.0 compatibility boundary:

- Upgrade `@neon/realtime` and any official adapters used by the application
  together to 0.2.0. The adapters now require core `^0.2.0`.
- Deploy a server that accepts `neon.realtime.v2` before upgrading clients. The
  SDK uses v2 for every connection and reconnect, with no v1 fallback. Enable
  ordered patches only after the client upgrade; old browser tabs must load the
  upgraded application to reconnect once the server requires v2.
- Custom raw consumers must handle the new `LiveQueryChange` variant
  `{ type: "move", rowId: string, afterRowId: string | null }`. It moves an
  existing row immediately after its predecessor, or to the head for `null`,
  without a row payload. Apply contents first, then moves in received order;
  stage and validate each complete batch before exposing the result.
- TanStack DB collections continue to synchronize membership and values as an
  unordered keyed collection and ignore moves. Collection iteration does not
  preserve server order, including for `ORDER BY`/`LIMIT` queries; use a TanStack
  local query to establish order, or core/React to preserve the server sequence.

Add the public `@neon/realtime/schema/realtime-protocol-v2.schema.json` export.
The existing v1 schema export remains available unchanged; it does not enable
v1 connections in the SDK.
