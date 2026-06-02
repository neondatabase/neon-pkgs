# @neondatabase/config

Config-as-Code for the Neon Platform. A repo-local `neon.ts` exports a TypeScript policy function describing a branch's desired state. This package exposes **functions** to inspect, diff, and deploy that policy against the Neon API.

> No CLI commands ship here, and the package is **filesystem- and env-agnostic**: it never reads `.neon` files or `NEON_*` environment variables. You pass `projectId` and the target branch explicitly (resolve them in your CLI, e.g. neonctl). This package is functions only.

## Install

```bash
npm install @neondatabase/config
```

## Define a policy

```ts
// neon.ts
import { defineConfig } from "@neondatabase/config/v1";

export default defineConfig((branch) => {
  if (branch.name === "main") {
    return { protected: true, auth: {} };
  }
  return { parent: "main", ttl: "7d" };
});
```

`parent` and `ttl` are branch lifecycle fields. Product-specific settings live under product namespaces such as `postgres`, `auth`, and `dataApi`.

## Functions

The three operations mirror the Terraform mental model: **`inspect`** (read live state), **`plan`** (dry-run diff), **`apply`** (reconcile).

`projectId` and `branchId` are **required** — there is no `.neon`/env fallback. (`projectId` is required because the Neon management API addresses every branch through its project; deriving it from a branch id would need an extra discovery round-trip.)

```ts
import config from "../neon";
import { inspect, plan, apply } from "@neondatabase/config/v1";

const target = { projectId: "patient-art-12345", branchId: "main" };

// Dry-run: what would apply do for this branch? No mutations.
const diff = await plan(config, target);

// Apply the policy to a branch. Never creates projects/branches.
await apply(config, { ...target, updateExisting: true });

// Read a branch's live Neon state as a plain object.
const live = await inspect(target);
```

| Function | Description |
| --- | --- |
| `inspect(options)` | Returns the branch's live Neon state (project + branch metadata and a reverse-engineered `BranchConfig`). Read-only. |
| `plan(config, options)` | Returns the dry-run diff — what `apply` would do for the branch, with no mutations. Returns a `PushResult` whose `applied` holds the plan and `conflicts` holds blocking drift. |
| `apply(config, options)` | Reconciles your local `neon.ts` policy onto the branch. Pass `updateExisting` to auto-confirm overriding existing remote settings and `allowProtectedBranch` to auto-confirm applying to a protected branch. |

`options` requires both `projectId` and `branchId` (a Neon branch id, `br-…`). Resolve branch names to ids before calling. The Neon API key resolves via the `apiKey` option → `NEON_API_KEY` → `~/.config/neonctl/credentials.json`.

## Lower-level engine

`inspect` / `plan` / `apply` are thin wrappers over `pullConfig(options)` / `pushConfig(config, options)` (both require `projectId` + `branchId`), which are also exported for advanced/programmatic use along with `defineConfig`, `loadConfigFromFile` (optional `neon.ts` loader), `createRealNeonApi`, the `PlatformError` base class + `ErrorCode` enum, the `errors` and `schemas` namespaces, and the supporting types.

```ts
import {
  defineConfig,
  inspect,
  plan,
  apply,
  pushConfig,
  pullConfig,
  loadConfigFromFile,
  createRealNeonApi,
  resolveApiKey,
  PlatformError,
  ErrorCode,
  errors,
  schemas,
} from "@neondatabase/config/v1";
```

## Safety Rules

- `apply` / `pushConfig` never creates projects or branches.
- `auth: {}` and `dataApi: {}` enable those integrations with Neon defaults. `auth.enabled: false`, `dataApi.enabled: false`, or absence leaves existing integrations alone. Disabling is destructive and remains explicit/manual.
- Mutable branch drift (`protected`, `ttl`, `postgres.computeSettings`) is reported as a conflict unless `updateExisting` is passed (or a `confirm` callback is supplied to `pushConfig`).
- Applying to a branch with the `protected` flag set on Neon requires `allowProtectedBranch` (or a `confirm` callback).

## Env vars

Connection-string resolution/injection lives in the companion package [`@neondatabase/env`](../env), which depends on this package for the `Config` type and the Neon API client.
