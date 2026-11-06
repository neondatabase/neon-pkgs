# @neon/realtime-tanstack

## 0.3.0

### Minor Changes

- 8e45ff1: Support TanStack DB 1.0 RC and its separate collection status and health
  lifecycles. Recoverable Realtime interruptions now appear in
  `health.failureReason`, while terminal failures retain ready rows and appear in
  `health.error`.

## 0.2.0

### Minor Changes

- 27f8fd0: Preserve server order in core materialized subscriptions and React, including
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

### Patch Changes

- Updated dependencies [27f8fd0]
- Updated dependencies [83d1b99]
- Updated dependencies [4a020a0]
- Updated dependencies [35b7679]
  - @neon/realtime@0.2.0

## 0.1.1

### Patch Changes

- 5216b7d: Infer live rows from the sealed query instead of weakening the result type to accept incompatible initial data or refresh callbacks.
- Updated dependencies [7f758b9]
- Updated dependencies [5216b7d]
  - @neon/realtime@0.1.1

## 0.1.0

### Minor Changes

- Promote the Neon Realtime SDK packages to 0.1.0 for the beta release.

### Patch Changes

- Updated dependencies
  - @neon/realtime@0.1.0

## 0.0.3

### Patch Changes

- b3cce2b: Unify raw query results under `onUpdate()` with `rows` and `changes` events. Complete-row results now remain `live`, `connecting` represents active synchronization, and `stale` is reserved for an expired capability awaiting renewal.
- Updated dependencies [b3cce2b]
- Updated dependencies [264c4fa]
  - @neon/realtime@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [c4a6fce]
  - @neon/realtime@0.0.2

## 0.0.1

### Patch Changes

- fee6b6a: Initial release of the Neon Realtime SDK packages.
- Updated dependencies [fee6b6a]
  - @neon/realtime@0.0.1
