# `@neon-internals/internal`

Client runtime/framework detection and `X-Neon-Client-Info` header injection shared by
`@neon/auth` and `@neon/postgrest-js`.

## It is private, and bundled into each consumer

Both consumers list it in `devDependencies` and build with tsdown bundling on, so it is
compiled into each `dist` and resolves nothing at runtime. That is what lets it stay
unpublished: a bare `@neon-internals/internal` specifier surviving into `dist` would fail to
resolve for anyone who installed `@neon/auth` or `@neon/postgrest-js` from npm.

It emits declarations even though nothing publishes it. Consumers re-export the `ClientInfo`
type that originates here, and a declaration bundler can only inline declarations that exist.

## Importing it

A single barrel export (`.`) — `getClientInfo`, `createClientInfoInjector`,
`X_NEON_CLIENT_INFO_HEADER`, and the `ClientInfo` type. There is only one logical concern here,
so there is no per-file subpath split to tree-shake.

## Rules

- **Keep it dependency-free.** Node/Deno/Bun/Edge runtime detection only, using ambient globals
  guarded by `typeof` checks. It is bundled into each consumer, so anything it imports becomes a
  runtime dependency of both.
