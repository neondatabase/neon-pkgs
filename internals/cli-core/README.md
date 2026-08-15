# `@neon-internals/cli-core`

Credential, profile and config-path code shared by the two CLIs that read a credential off
disk: `neon` and `@neon/env`. `@neon/config` is not a consumer — it takes an
explicit `apiKey` and touches neither the filesystem nor the environment, which is why its
`./paths` subpath was removed rather than re-exported from here.

`neon init` is a third reader, but not a third consumer: it lives inside `packages/cli` as
`src/init/auth.ts` and imports through that package's own dependency on this one.

## It is private, and bundled into each consumer

Both consumers list it in `devDependencies` and build with tsdown bundling on, so it is
compiled into each `dist` and resolves nothing at runtime. That is what lets it stay
unpublished: a bare `@neon-internals/cli-core` specifier surviving into `dist` would fail to
resolve for anyone who installed `neon` or `@neon/env` from npm.

It emits declarations even though nothing publishes it. `@neon/env` re-exports types that
originate here, and a declaration bundler can only inline declarations that exist.

## Importing it

Per-file subpaths, and **no root export** — there is deliberately no barrel, so a consumer takes
only what it names and the rest is tree-shaken out of their bundle. `@neon-internals/cli-core` on
its own answers `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The specifier is **extensionless**, unlike every relative import in this repo:

```ts
import { configDir } from "@neon-internals/cli-core/paths";     // resolves
import { configDir } from "@neon-internals/cli-core/paths.js";  // dist/paths.js.js
```

In `packages/cli` the `.js` form passes `tsc --noEmit` — its `paths` mapping plus tsc's
`.js`-to-`.d.ts` substitution hides it — and fails at bundle time instead. `packages/env` is on
`NodeNext` and rejects it at both.

## Rules

- **It is not published, and one line keeps it that way.** `neon` exports a `./dist/*` wildcard,
  so every emitted file is importable by path unless blocked. `"./dist/_chunks/*": null` in
  `packages/cli/package.json` is what stops `neon/dist/_chunks/credentials-<hash>.js` being a
  public credential reader; `packages/cli/src/package_exports.test.ts` pins it.
- **Keep it dependency-free.** Node builtins only. It is bundled into each consumer, so
  anything it imports becomes a runtime dependency of all of them. The OS keyring adapter
  (`@napi-rs/keyring`) lives in each consumer, not here; this package takes a
  `KeyringBackend` and never loads a native addon.
- **Storage is the profile pointer.** `profiles.json` `credentials` is a file path
  or the sentinel `"keyring"`. There is no directory-wide preference and no
  `config.json` / `NEON_CRED_STORAGE`.
- **A keyring get of `null` or delete of `false` is not proof the item is gone.**
  `@napi-rs/keyring@1.3.0` collapses locked and denied access the same way. When
  the pointer is `"keyring"` and `get` returns null, `read()` throws
  `KeyringUnreadableError` rather than returning null — that is not "never signed
  in", and it must not start OAuth. `profile remove` still drops the pointer
  when the item cannot be confirmed gone, and warns that a leftover may remain.
- **No logger, no yargs, no API client.** Take a callback or a value instead; the imperative
  shell belongs in the consumer.
- Unit tests live in `packages/cli`, so the code is covered once rather than three times.
  `@neon/env`'s `resolve-api-key.test.ts` additionally checks that the two CLIs agree on
  precedence — that is the regression this package exists to prevent.
