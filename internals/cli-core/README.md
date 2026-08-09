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

## Rules

- **It is not published, and one line keeps it that way.** `neon` exports a `./dist/*` wildcard,
  so every emitted file is importable by path unless blocked. `"./dist/_chunks/*": null` in
  `packages/cli/package.json` is what stops `neon/dist/_chunks/credentials-<hash>.js` being a
  public credential reader; `packages/cli/src/package_exports.test.ts` pins it.
- **Keep it dependency-free.** Node builtins only. It is bundled into each consumer, so
  anything it imports becomes a runtime dependency of all of them.
- **No logger, no yargs, no API client.** Take a callback or a value instead; the imperative
  shell belongs in the consumer.
- Unit tests live in `packages/cli`, so the code is covered once rather than three times.
  `@neon/env`'s `resolve-api-key.test.ts` additionally checks that the two CLIs agree on
  precedence — that is the regression this package exists to prevent.
