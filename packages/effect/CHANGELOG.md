# @neon/effect

## 0.2.2

### Patch Changes

- Updated dependencies [207d650]
  - @neon/sdk@7.6.1

## 0.2.1

### Patch Changes

- Updated dependencies [d7b777c]
  - @neon/sdk@7.6.0

## 0.2.0

### Minor Changes

- c745d8e: Add `neon.projects.count()`, which returns the number of active projects in the organization without paging through `projects.list()` (`GET /projects/count`, beta). It takes `{ org_id? }` and defaults to the client's `orgId`. `@neon/tools` publishes it as the `projects.count` selector (`count_projects`), and `@neon/effect` exposes it as an `Effect<number>`.

### Patch Changes

- Updated dependencies [c745d8e]
- Updated dependencies [d23ace5]
  - @neon/sdk@7.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [8b0e72b]
- Updated dependencies [cb6a151]
  - @neon/sdk@7.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [0cee585]
  - @neon/sdk@7.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [5f572b6]
  - @neon/sdk@7.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [025988c]
  - @neon/sdk@7.1.0

## 0.1.1

### Patch Changes

- Updated dependencies [d1ddfe5]
  - @neon/sdk@7.0.1

## 0.1.0

### Minor Changes

- 4ffd4eb: New package: Effect v4 bindings for `@neon/sdk`. Every client method returns an `Effect`, paginated lists return a `Stream`, SDK errors are tagged for `Effect.catchTag`, and interrupting a fiber cancels the request. Provide the client with `layer(config)` or `layerConfig`, or create one with `make(config)`.
