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
- `buildFunctionBundle` — bundle Neon Functions for deploy. Honours the function's `externalPackages`: every entry is passed to esbuild's `external`, and unless it sets `includeFiles: false` the package's real files are staged into the archive alongside the bundle. Reports a bundled-in native dependency that was never declared, as a warning.
- `traceNativePackages` — install the packages a function stages for the runtime target (`RUNTIME_TARGET`: linux-arm64, glibc) into a throwaway directory, trace the files they reach, and return them keyed by archive path with the `node_modules` layout preserved. Called by `buildFunctionBundle`; exported for a CLI that supplies its own bundler.
- `findUndeclaredNativePackages` / `describeNativeFinding` — advisory detection of a native package that was bundled in without being declared, and the report text for it. Evidence only: it cannot prove the code path is reached, so it must never fail a deploy.
- `assertZipWithinLimits` — check a finished archive against the build service's size limits (`DEFAULT_ARCHIVE_LIMITS`), with an error naming the largest files.

```ts
import { inspect, plan, apply } from "@neon/config-runtime/v1";
```

See [`@neon/config`](../config) for authoring the `neon.ts` policy these operate on.
