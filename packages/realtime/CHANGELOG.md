# @neon/realtime

## 0.0.2

### Patch Changes

- c4a6fce: Delegate SQL and prepared-query validation to the Realtime proxy. ORM adapters now forward compiled queries without locally restricting their SQL shape, and `validateLiveSelectSql` is no longer exported from `@neon/realtime/server`.

## 0.0.1

### Patch Changes

- fee6b6a: Initial release of the Neon Realtime SDK packages.
