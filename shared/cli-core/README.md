# `shared/cli-core`

Credential, profile and config-path code shared by every CLI in this repo — `neon`,
`@neon/env`, `neon-init` — and by `@neon/config`, which re-exports the path half of it.

## It is not a package, on purpose

It is **compiled into each consumer as if it were their own source**. `scripts/sync-shared.mjs`
copies `src/` into each consumer's `src/_shared/` before they build, that copy is gitignored, and
the imports are relative — so the emitted `dist` contains the code and resolves nothing at
runtime.

A workspace package would not work here, and the reasons are worth recording:

- Every package builds with `bundle: false` (tsdown) or plain `tsc`, so a bare specifier
  survives into `dist` and has to resolve from `node_modules` at runtime. An unpublished
  package cannot, for anyone who installed `neon` or `@neon/env` from npm.
- `bundledDependencies` is the mechanism for exactly that, and pnpm refuses it here:
  `ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED`. It needs `nodeLinker: hoisted`, which is a
  workspace-wide change to dependency resolution.
- Publishing it would put an internal surface on the registry, and `@neon/config` — the one
  published package all of this could hang off — is consumer-facing.

## Rules

- **Edit `shared/cli-core/src`, never `packages/*/src/_shared`.** The latter is generated and
  overwritten on every build.
- **Keep it dependency-free.** Node builtins only. `neon-init` has no workspace dependencies and
  this code has to work there.
- **No logger, no yargs, no API client.** Take a callback or a value instead; the imperative
  shell belongs in the consumer.
- Tests live in `packages/cli`, which is the only consumer that runs them, so the code is
  covered once rather than four times.
