# `shared/env-core`

Resolving a branch's env from the Neon API, and the credential reuse that has to wrap it.
Shared by the two things that do it: `@neon/env` (which publishes `fetchEnv` and `toEntries`
from here) and the `neon` CLI (`env pull`, `dev`, `link`, `checkout`, `config apply`).

| File | What |
| --- | --- |
| `env.ts` | `fetchEnv`, `NEON_ENV_VAR_KEYS`, the `NeonEnv` shapes, `toEntries` |
| `reuse-secrets.ts` | `fetchEnvReusingSecrets` — verify persisted one-time secrets, mint and revoke only when it must |

`parseEnv` is deliberately **not** here. It reads `process.env`, only `@neon/env` needs it, and
keeping it out keeps `zod` out of every consumer that copies this tree.

## Why `fetchEnvReusingSecrets` is not published

It used to be, at `@neon/env/runtime`, and that was a mistake worth not repeating. It reads an
env source and can mint and revoke branch credentials — a library that revokes your credentials
because you imported it is a library you cannot safely embed. Its only consumers are our own
two CLIs. Shared source is what that is; a published subpath was a way of moving it between
packages, and the wrong one.

## It is not a package, on purpose

Same mechanism and the same reasons as [`shared/cli-core`](../cli-core/README.md): compiled
into each consumer as its own source by `scripts/sync-shared.mjs`, which copies `src/` into
`packages/{cli,env}/src/_shared/env-core/` before either builds. That copy is gitignored and
the imports are relative, so the emitted `dist` contains the code and resolves nothing at
runtime.

It lands in a subdirectory while `cli-core` copies flat — nesting `cli-core` now would churn
every existing `../_shared/<file>.js` import for nothing. Anything added after it gets its own
subdirectory, so two trees can never collide on a filename.

**This is a workaround for not bundling, and worth replacing.** The ordinary way to share
private code in a monorepo is a `"private": true` workspace package listed in the consumer's
`devDependencies`, which a bundler then inlines into `dist` — [Vercel's `@vercel-internals/*`
packages](https://github.com/vercel/vercel/blob/main/internals/types/package.json) work exactly
that way, inlined by `esbuild({ bundle: true, external: dependencies })`. We cannot, because
`packages/env` builds with tsdown `bundle: false` and `packages/cli` with plain `tsc`, so a bare
specifier survives into `dist` and has to resolve from `node_modules` — which an unpublished
package cannot do for anyone who installed from npm. Put the two published artifacts on a
bundler and this directory becomes a normal private package.

## Rules

- **Edit `shared/env-core/src`, never `packages/*/src/_shared`.** The latter is generated and
  overwritten on every build.
- **`@neon/config` is the only dependency.** Both consumers already have it. Anything else you
  import becomes a runtime dependency of both, so add one only deliberately — that is why
  `parseEnv` and its `zod` schemas stayed behind in `@neon/env`.
- **Any script that compiles a consumer's `src/` must run the sync first.** A `vitest` or `tsc`
  invoked directly will happily use whatever copy is already there.
- Tests live in `packages/env` (`env.test.ts`, `reuse-secrets.test.ts`, the contract and type
  tests), so this code is covered once rather than in both consumers.
