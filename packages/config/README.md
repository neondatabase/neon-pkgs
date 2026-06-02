# @neondatabase/config

Config-as-Code for the Neon Platform. A repo-local `neon.ts` exports a TypeScript policy function describing a branch's desired state. This package exposes **functions** to inspect, diff, and deploy that policy against the Neon API.

> No CLI commands ship here — branch/project selection and command-line wrappers live in the neonctl CLI. This package is functions only.

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

```ts
import config from "../neon";
import { status, deploy, pull } from "@neondatabase/config/v1";

// Dry-run: what would deploy do for the selected branch? No mutations.
const plan = await status(config, "main");

// Apply the policy to a branch (id `br-…` or name). Never creates projects/branches.
await deploy(config, "main", { updateExisting: true });

// Read a branch's live Neon state as a plain object.
const live = await pull("main");
```

| Function | Description |
| --- | --- |
| `status(config, branchId?, options?)` | Returns the diff (dry-run). Shows what `deploy` would do for the selected branch, with no mutations. Returns a `PushResult` whose `applied` holds the plan and `conflicts` holds blocking drift. |
| `pull(branchId?, options?)` | Returns the selected branch's live Neon state (project + branch metadata and a reverse-engineered `BranchConfig`). |
| `deploy(config, branchId?, options?)` | Pushes your local `neon.ts` policy to the selected Neon branch. Pass `updateExisting` to auto-confirm overriding existing remote settings and `allowProtectedBranch` to auto-confirm pushing to a protected branch. |

All functions resolve the project + branch through the standard chain:

| Field | 1st | 2nd | 3rd |
| --- | --- | --- | --- |
| project | option (`projectId`) | `NEON_PROJECT_ID` | `.neon[/project.json].projectId` |
| branch | `branchId` arg | `NEON_BRANCH_ID` | `.neon[/project.json].branchId` |

The Neon API key resolves via `apiKey` option → `NEON_API_KEY` → `~/.config/neonctl/credentials.json`.

## Lower-level engine

`status` / `deploy` / `pull` are thin wrappers over `pushConfig` / `pullConfig`, which are also exported for advanced/programmatic use along with `defineConfig`, `loadConfigFromFile`, `loadContext`, `createRealNeonApi`, the `PlatformError` base class + `ErrorCode` enum, the `errors` and `schemas` namespaces, and the supporting types.

```ts
import {
  defineConfig,
  status,
  deploy,
  pull,
  pushConfig,
  pullConfig,
  loadConfigFromFile,
  loadContext,
  createRealNeonApi,
  resolveApiKey,
  PlatformError,
  ErrorCode,
  errors,
  schemas,
} from "@neondatabase/config/v1";
```

## Safety Rules

- `deploy` / `pushConfig` never creates projects or branches.
- `auth: {}` and `dataApi: {}` enable those integrations with Neon defaults. `auth.enabled: false`, `dataApi.enabled: false`, or absence leaves existing integrations alone. Disabling is destructive and remains explicit/manual.
- Mutable branch drift (`protected`, `ttl`, `postgres.computeSettings`) is reported as a conflict unless `updateExisting` is passed (or a `confirm` callback is supplied to `pushConfig`).
- Deploying to a branch with the `protected` flag set on Neon requires `allowProtectedBranch` (or a `confirm` callback).

## Env vars

Connection-string resolution/injection lives in the companion package [`@neondatabase/env`](../env), which depends on this package for the `Config` type and the Neon API client.
