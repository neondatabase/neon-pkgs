# @neon/effect

## 0.1.0

### Minor Changes

- 4ffd4eb: New package: Effect v4 bindings for `@neon/sdk`. Every client method returns an `Effect`, paginated lists return a `Stream`, SDK errors are tagged for `Effect.catchTag`, and interrupting a fiber cancels the request. Provide the client with `layer(config)` or `layerConfig`, or create one with `make(config)`.
