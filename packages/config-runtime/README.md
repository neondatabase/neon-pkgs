# @neondatabase/config-runtime

Imperative runtime for [`@neondatabase/config`](../config): run a `neon.ts` policy against the Neon API — `inspect`, `plan`, `apply` (push/pull) — and bundle + deploy Neon Functions.

> This package pulls in `esbuild`, so import it from your CLI or CI — **not** from a `neon.ts` policy. Keep policies side-effect-free; that's what `@neondatabase/config` is for. New code should import from `@neondatabase/config-runtime/v1` to pin a major.

## Install

```bash
npm install @neondatabase/config-runtime
```

## API

- `inspect` / `plan` / `apply` — read the current branch state, diff a policy against it, and apply the changes.
- `pullConfig` / `pushConfig` — lower-level pull/push primitives.
- `createBranch` — create a branch to target.
- `buildFunctionBundle` — bundle Neon Functions for deploy.

```ts
import { inspect, plan, apply } from "@neondatabase/config-runtime/v1";
```

See [`@neondatabase/config`](../config) for authoring the `neon.ts` policy these operate on.
