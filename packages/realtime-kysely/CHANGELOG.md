# @neon/realtime-kysely

## 0.1.0

### Minor Changes

- Promote the Neon Realtime SDK packages to 0.1.0 for the beta release.

### Patch Changes

- Updated dependencies
  - @neon/realtime@0.1.0

## 0.0.3

### Patch Changes

- Updated dependencies [b3cce2b]
- Updated dependencies [264c4fa]
  - @neon/realtime@0.0.3

## 0.0.2

### Patch Changes

- c4a6fce: Delegate SQL and prepared-query validation to the Realtime proxy. ORM adapters now forward compiled queries without locally restricting their SQL shape, and `validateLiveSelectSql` is no longer exported from `@neon/realtime/server`.
- Updated dependencies [c4a6fce]
  - @neon/realtime@0.0.2

## 0.0.1

### Patch Changes

- fee6b6a: Initial release of the Neon Realtime SDK packages.
- Updated dependencies [fee6b6a]
  - @neon/realtime@0.0.1
