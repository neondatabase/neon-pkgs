# @neon/realtime

## 0.2.1

### Patch Changes

- f7f9c91: Pace automatic capability refreshes when replacement tokens remain inside the early-refresh window, including when the client clock is ahead.
- b4aad99: Ignore renewal acknowledgements for subscriptions pending detachment so unsubscribing during renewal does not fail other subscriptions sharing the connection.
- 19590ae: `QueryRefreshController` stops refreshing once its subscription is in `error` or `closed`. A failed subscription rejects every renewal, and the controller used to retry about once a second, calling `refreshQuery` (usually the app's seal endpoint) each time. `useLiveQuery` in `@neon/realtime-react` uses this controller, so it stops too.
- d05fdbd: Reset all subscription wire state before reconnect callbacks, so a state listener can safely unsubscribe another query during a disconnect.
- c628765: Do not resubscribe a live query when a stale-state listener unsubscribes or closes the client during capability replacement.
- c0ad38d: Prevent late manual capability-renewal completions from overwriting newer replacements or changing a stopped refresh controller.
- 71a7fdb: Keep a subscription connecting when an older renewal is superseded by a newer one, instead of restoring the stale state from the cancelled renewal.

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

- 83d1b99: Report the exact client version during connection setup and display non-terminal upgrade warnings from the Realtime proxy.

### Patch Changes

- 4a020a0: Decode Realtime rows with large bytea values. Values above about 3 MiB were rejected with a protocol error, because the base64 check ran as a regular expression that overflowed V8's call stack. The check now runs in linear time and accepts exactly the same canonical base64 as before, so rows up to the 4 MiB server limit decode.
- 35b7679: Send bounded SDK release-line and query-source metadata for aggregate Realtime
  usage metrics. Protocol v2 clients send one `client_info` message after `ready`
  and before subscription commands; sealed capabilities use capability v2.
  Official Drizzle and Kysely adapters identify their query source, while custom
  adapters default to the fixed `custom` category.

## 0.1.2

### Patch Changes

- acd0dd7: Support React Native clients through the package root, including runtimes without `TextDecoder` or `atob`, and allow platform-specific WebSocket construction.

## 0.1.1

### Patch Changes

- 7f758b9: Preserve sealed queries' live row types through JSON-aware RPC typing. Serialized initial data must be converted to the live row representation before being passed to the SDK; for example, restore JSON date strings to `Date` objects when the live parser returns `Date`.
- 5216b7d: Infer live rows from the sealed query instead of weakening the result type to accept incompatible initial data or refresh callbacks.

## 0.1.0

### Minor Changes

- Promote the Neon Realtime SDK packages to 0.1.0 for the beta release.

### Patch Changes

- 475adfb: Remove the 1 MiB client-side limit on incoming Realtime WebSocket messages.
- 475adfb: Remove the client-side 16 MiB limits on publications and buffered change backlogs.

## 0.0.3

### Patch Changes

- b3cce2b: Unify raw query results under `onUpdate()` with `rows` and `changes` events. Complete-row results now remain `live`, `connecting` represents active synchronization, and `stale` is reserved for an expired capability awaiting renewal.
- 264c4fa: Allow baseline syncs larger than 16 MiB by removing the client-side baseline assembly limit.

## 0.0.2

### Patch Changes

- c4a6fce: Delegate SQL and prepared-query validation to the Realtime proxy. ORM adapters now forward compiled queries without locally restricting their SQL shape, and `validateLiveSelectSql` is no longer exported from `@neon/realtime/server`.

## 0.0.1

### Patch Changes

- fee6b6a: Initial release of the Neon Realtime SDK packages.
