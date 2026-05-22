# @neondatabase/platform

IaC and Config-as-Code for the Neon Platform. Describe your project, branch blueprints, TTLs, and compute settings in a single `neon.ts` file at the root of your repo, then `pullConfig` / `pushConfig` to sync against the [Neon API](https://api-docs.neon.tech).

> This package exposes the SDK only. The user-facing CLI surface lives in `neonctl` (`neonctl platform pull|push|branch`) and wraps these functions.

## Install

```bash
pnpm add @neondatabase/platform
# or
npm install @neondatabase/platform
```

Requires Node.js ≥ 22.

## Quick start

Create a `neon.ts` at the root of your repo:

```ts
import { defineConfig } from "@neondatabase/platform/v1";

export default defineConfig({
  project: {
    name: "my-app",
    region: "aws-us-east-1",
  },
  branchBlueprints: {
    production: {
      computeSettings: {
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 2,
        suspendTimeoutSeconds: 300,
      },
    },
    preview: {
      pattern: "preview-*",
      ttl: "1h",
      parent: "production",
    },
  },
});
```

Then either pull or push:

```ts
import { pullConfig, pushConfig } from "@neondatabase/platform/v1";

// pull the current Neon state into a Config object (read-only on disk)
const remoteConfig = await pullConfig({ apiKey: process.env.NEON_API_KEY });

// push your local neon.ts to Neon. With no arguments it auto-loads neon.ts and
// refuses to apply if the local config conflicts with the remote project state.
await pushConfig();

// force-apply, including drift on existing branches and wildcard-matched ones
await pushConfig({
  applyChanges: true,
  updateExisting: true,
  applyExisting: true,
});
```

## API

### `defineConfig(input: Config): Config`

Validates and freezes a config using the zod-based {@link configSchema}. Throws `ConfigValidationError` (collecting every issue at once) when something is malformed. Pure function — no I/O.

The underlying schema (and its sub-schemas) is also exported so you can compose it into your own validation pipeline:

```ts
import {
  configSchema,
  projectConfigSchema,
  branchBlueprintSchema,
  computeSettingsSchema,
} from "@neondatabase/platform/v1";

const parsed = configSchema.safeParse(unknownInput);
if (!parsed.success) console.error(parsed.error.format());
```

### `pullConfig(options?: PullConfigOptions): Promise<Config>`

Reads the live Neon project state and returns a `Config` object. The package is **filesystem-read-only**: it never writes `.neon/project.json` or `neon.ts`. If you want to persist the pulled config, do so from `neonctl` or your own glue.

Project resolution order:
1. `options.projectId` (explicit)
2. `.neon/project.json` walking up from `options.cwd ?? process.cwd()`
3. `.neon` (neonctl's existing context file) walking up from the same directory

If none of those produce a project id, `pullConfig` throws `MissingContextError`.

### `pushConfig(...): Promise<PushResult>`

Three overloads:

```ts
pushConfig();                          // auto-load neon.ts, fail on conflict
pushConfig(options);                   // auto-load neon.ts, configurable behaviour
pushConfig(config, options?);          // use an already-validated Config object
```

Important options:

| Option            | Default | Effect                                                                                                                                    |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `applyChanges`    | `false` | When `false`, push fails (`PushConflictError`) if any field-level conflict is detected. When `true`, push patches the remote regardless.  |
| `updateExisting`  | `false` | When `true`, settings/TTL drift on **specific-name** blueprints (e.g. `production`) is applied to the existing branch instead of failing. |
| `applyExisting`   | `false` | When `true`, blueprints with wildcard patterns (e.g. `preview-*`) apply their settings/TTL to **every matching existing branch**.         |

`pushConfig` will create a project if none exists in the resolved org/name combination and `project.region` is set. Region and Postgres major version are immutable on Neon — pushing a different value surfaces a `ConflictReport`.

### `loadContext(options?: LoadContextOptions): NeonContext`

Resolves the Neon project and (optionally) branch this process should target. Pure helper — does no network calls and never writes to disk. The resolution chain is the same one `pullConfig` / `pushConfig` use internally:

| Field      | 1st (call args)         | 2nd (env)         | 3rd (file)                          |
| ---------- | ----------------------- | ----------------- | ----------------------------------- |
| `branch`   | `options.branch`        | `NEON_BRANCH_ID`  | `branchId` in `.neon[/project.json]` |
| `projectId`| `options.projectId`     | `NEON_PROJECT_ID` | `projectId` in `.neon[/project.json]`|
| `orgId`    | `options.orgId`         | `NEON_ORG_ID`     | `orgId` in `.neon[/project.json]`   |

Throws `MissingContextError` when no project id can be resolved. `branch` is optional — use `loadContextWithBranch()` if you want a hard error when no branch is supplied.

```ts
import { loadContext } from "@neondatabase/platform/v1";

const ctx = loadContext({ branch: "preview-pr-42" });
// ctx.projectId         "proj-cool-name-123"
// ctx.orgId              "org-abc-456"
// ctx.branch             { kind: "name", value: "preview-pr-42" }
// ctx.sourcePath         "/repo/.neon/project.json"
```

## Read-only filesystem contract

The package never creates, updates, or deletes files. In particular it does **not** write `.neon/project.json`. To bootstrap a project-context file, use `neon set-context` (which writes `.neon`) or any other tool of your choice. This package will happily read both layouts.

## Testing your IaC

Inject a custom `api` (any object implementing `NeonApi`) to test pull/push flows without hitting the real Neon API. The package ships its public `NeonApi` interface so you can build your own fakes — internally, the test suite uses an in-memory fake (not vendored to consumers) that exercises the same interface.

```ts
import type { NeonApi } from "@neondatabase/platform/v1";
import { pushConfig } from "@neondatabase/platform/v1";

const api: NeonApi = /* your fake */;
await pushConfig(myConfig, { api, projectId: "proj-test" });
```
