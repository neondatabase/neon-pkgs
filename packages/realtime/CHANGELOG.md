# @neon/realtime

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
