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
- Connections and reconnects now require `neon.realtime.v2`, with no v1 fallback.
- Custom raw consumers must handle the new `LiveQueryChange` variant
  `{ type: "move", rowId: string, afterRowId: string | null }`. It moves an
  existing row immediately after its predecessor, or to the head for `null`,
  without a row payload. Apply contents first, then moves in received order;
  stage and validate each complete batch before exposing the result.
- TanStack DB collections continue to synchronize membership and values as an
  unordered keyed collection and ignore moves. Collection iteration does not
  preserve server order, including for `ORDER BY`/`LIMIT` queries; use a TanStack
  local query to establish order, or core/React to preserve the server sequence.
