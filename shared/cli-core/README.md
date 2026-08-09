# `shared/cli-core`

Credential, profile and config-path code shared by the two CLIs that read a credential off
disk: `neon` and `@neon/env`. `@neon/config` is not a consumer — it takes an
explicit `apiKey` and touches neither the filesystem nor the environment, which is why its
`./paths` subpath was removed rather than re-exported from here.

`neon init` is a third reader, but not a third consumer: it lives inside `packages/cli` as
`src/init/auth.ts` and imports the copy already synced into that package.

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

- **It is not published, and one line keeps it that way.** `neon` exports a `./dist/*` wildcard,
  so every file compiled from here is importable by path unless blocked. `"./dist/_shared/*":
  null` in `packages/cli/package.json` is what stops `neon/dist/_shared/credentials.js` being a
  public credential reader; `packages/cli/src/package_exports.test.ts` pins it.
- **Edit `shared/cli-core/src`, never `packages/*/src/_shared`.** The latter is generated and
  overwritten on every build.
- **Keep it dependency-free.** Node builtins only. It is compiled into each consumer as that
  consumer's own source, so anything it imports becomes a runtime dependency of all of them.
- **No logger, no yargs, no API client.** Take a callback or a value instead; the imperative
  shell belongs in the consumer.
- Unit tests live in `packages/cli`, so the code is covered once rather than three times.
  `@neon/env`'s `resolve-api-key.test.ts` additionally checks that the two CLIs agree on
  precedence — that is the regression this directory exists to prevent.
- **Any script that compiles a consumer's `src/` must run the sync first.** A `vitest` or `tsc`
  invoked directly will happily use whatever copy is already there.
