# @neon/effect

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
