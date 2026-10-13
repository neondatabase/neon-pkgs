# @neon/realtime

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
