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
- `buildFunctionBundle` — bundle Neon Functions for deploy. Honours the function's `externalPackages`, passing each entry to esbuild's `external`.

```ts
import { inspect, plan, apply } from "@neon/config-runtime/v1";
```

See [`@neon/config`](../config) for authoring the `neon.ts` policy these operate on.
