# @neondatabase/platform

IaC and Config-as-Code for the Neon Platform. Describe your project, branch blueprints, TTLs, and compute settings in a single `neon.ts` file at the root of your repo, then `pullConfig` / `pushConfig` to sync against the [Neon API](https://api-docs.neon.tech).

> The user-facing CLI surface for end-users lives in [`neonctl`](https://github.com/neondatabase/neonctl) (`neon platform pull|push|branch`) and wraps the SDK exported here. This package also ships a thin standalone `neon-platform` CLI so the same commands can be exercised in isolation — see [CLI](#cli) below.

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

## CLI

The package ships a `neon-platform` binary (analogous to `neon-init`) that wraps the SDK so the same commands can be exercised in isolation before they are wired into `neonctl`.

```bash
# Once installed (locally or via npx):
neon-platform --help

# Print the resolved project + branch context as JSON
neon-platform context

# Pull the live state of the project into a neon.ts snippet (default) or JSON
neon-platform pull
neon-platform pull --format json --project-id proj-cool-snow-123

# Push your local neon.ts to the resolved Neon project
neon-platform push                                # fail on conflict
neon-platform push --update-existing              # update existing specific-name branches
neon-platform push --apply-existing               # apply wildcard blueprints to existing matching branches
neon-platform push --apply-changes                # force-apply, ignoring branch-level conflicts
```

Exit codes:

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Success                                                                |
| 1    | Generic error (e.g. missing `NEON_API_KEY`, transport-level failure)   |
| 2    | `PushConflictError` (re-run with `--apply-changes` / `--update-existing`) |
| 3    | `MissingContextError` (no project id resolvable)                       |
| 4    | `ConfigLoadError` (couldn't find / load `neon.ts`)                     |
| 5    | Other `PlatformError` (ambiguous project, missing region, …)           |

All flags accept env-var fallbacks: `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_ORG_ID`, `NEON_BRANCH_ID`.

## Read-only filesystem contract

The package never creates, updates, or deletes files. In particular it does **not** write `.neon/project.json`. To bootstrap a project-context file, use `neon set-context` (which writes `.neon`) or any other tool of your choice. This package will happily read both layouts.

## API key scopes

`@neondatabase/platform` supports both **organisation/user-scoped** and **project-scoped** Neon API keys:

| Scope                | `pullConfig` | `pushConfig` (with `projectId`) | `pushConfig` (without `projectId`) |
| -------------------- | ------------ | ------------------------------- | ---------------------------------- |
| Org or user-scoped   | ✅            | ✅                               | ✅ (looks up by name, may create)   |
| Project-scoped       | ✅            | ✅                               | ❌ — `PLATFORM_INSUFFICIENT_SCOPE`  |

Project-scoped keys can only operate on a single project. Pass `projectId` explicitly (SDK), use `--project-id` (CLI), set `NEON_PROJECT_ID`, or commit a `.neon/project.json` so push knows where to apply.

When using an org-scoped key, leave `orgId` unset — the API key implicitly scopes every request to its owning org.

## Running e2e tests

`pnpm --filter @neondatabase/platform test:e2e` spins up real Neon projects and tears them down. Requirements:

1. Create `packages/platform/.env` (gitignored) from `.env.example` and put an **org-scoped** API key in `NEON_API_KEY`. The org should be empty (or at least not contain projects named `neon-platform-e2e-*`).
2. The suite runs single-threaded with 120s per-test timeouts.
3. A startup sweep deletes any orphaned `neon-platform-e2e-*` projects from a previous failed run.
4. Each test names its project `neon-platform-e2e-<uuid>-<purpose>` and registers it for cleanup, even if the test fails mid-way.

Tests skip the "create project" portions when only a project-scoped key is available; set `NEON_PROJECT_ID` in `.env` to point the bounded subset at an existing project.

## Testing your IaC

Inject a custom `api` (any object implementing `NeonApi`) to test pull/push flows without hitting the real Neon API. The package ships its public `NeonApi` interface so you can build your own fakes — internally, the test suite uses an in-memory fake (not vendored to consumers) that exercises the same interface.

```ts
import type { NeonApi } from "@neondatabase/platform/v1";
import { pushConfig } from "@neondatabase/platform/v1";

const api: NeonApi = /* your fake */;
await pushConfig(myConfig, { api, projectId: "proj-test" });
```
