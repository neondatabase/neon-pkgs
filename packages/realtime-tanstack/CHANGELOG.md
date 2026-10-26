# @neon/realtime-tanstack

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
