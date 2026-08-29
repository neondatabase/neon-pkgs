# @neon/config-runtime

Imperative runtime for [`@neon/config`](../config): run a `neon.ts` policy against the Neon API — `inspect`, `plan`, `apply` (push/pull) — and bundle + deploy Neon Functions.

> This package pulls in `esbuild`, so import it from your CLI or CI — **not** from a `neon.ts` policy. Keep policies side-effect-free; that's what `@neon/config` is for. New code should import from `@neon/config-runtime/v1` to pin a major.

## Install

```bash
npm install @neon/config-runtime
```

> **Requirements:** Node.js >= 20.19.

## API

- `inspect` / `plan` / `apply` — read the current branch state, diff a policy against it, and apply the changes.
- `pullConfig` / `pushConfig` — lower-level pull/push primitives.
- `createBranch` — create a branch to target.
- `buildFunctionBundle` — ZIP a function for deploy, honoring `bundler`. Omit / `"esbuild"`: a file `source` is the entry; a directory is searched for `index.ts`, then `index.js`, then `index.mjs`. `"none"`: zip `source` as-is. An inline function: zip the file map it returns. On the esbuild path, `externalPackages` are passed to esbuild's `external`, and unless an entry sets `includeFiles: false` the package's real files are staged into the archive. Reports a bundled-in native dependency that was never declared, as a warning.
- `bundleAsIs` — read a prebuilt directory or `index.mjs` / `index.js` file into a file map without loading esbuild. The packaged CLI uses this for `bundler: "none"` / `--no-bundle` so it never pulls esbuild into its snapshot. `buildFunctionBundle` calls it for `"none"`; call it directly when you need the file map (for example to write files for `neon dev`) rather than a ZIP.
- `resolveEsbuildEntry` — resolve a file or directory `source` to the esbuild entry path.
- `traceNativePackages` — install the packages a function stages for the runtime target (`RUNTIME_TARGET`: linux-arm64, glibc) into a throwaway directory, trace the files they reach, and return them keyed by archive path with the `node_modules` layout preserved. Called by `buildFunctionBundle`; exported for a CLI that supplies its own bundler.
- `findUndeclaredNativePackages` / `describeNativeFinding` — advisory detection of a native package that was bundled in without being declared, and the report text for it. Evidence only: it cannot prove the code path is reached, so it must never fail a deploy.
- `assertZipWithinLimits` — check a finished archive against the build service's size limits (`DEFAULT_ARCHIVE_LIMITS`), with an error naming the largest files.

```ts
import { inspect, plan, apply } from "@neon/config-runtime/v1";
```

See [`@neon/config`](../config) for authoring the `neon.ts` policy these operate on.
