# @neondatabase/platform

IaC and Config-as-Code for the Neon Platform. Describe your project, the persistent branches it should have, and the ephemeral-branch templates you spin up via `branch()` — all in a single `neon.ts` file at the root of your repo — then `pullConfig` / `pushConfig` to sync against the [Neon API](https://api-docs.neon.tech).

> The user-facing CLI surface for end-users lives in [`neonctl`](https://github.com/neondatabase/neonctl) (`neon platform pull|push|branch`) and wraps the SDK exported here. This package also ships a thin standalone `neon-ts` CLI so the same commands can be exercised in isolation — see [CLI](#cli) below.

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
  branches: {
    production: {
      protected: true,
      computeSettings: {
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 2,
        suspendTimeout: "5m",
      },
    },
    staging: {
      parent: "production",
    },
  },
  branchBlueprints: {
    preview: {
      pattern: "preview-*",
      ttl: "1h",
      parent: "production",
    },
  },
});
```

The config has two intentionally distinct branch surfaces:

- **`branches`** — concrete, persistent branches. The map key is the literal branch name on Neon. Managed by `pushConfig` (create-if-missing, update-on-drift with `updateExisting`). Supports `protected`, `computeSettings`, and a `parent` reference.
- **`branchBlueprints`** — templates for *ephemeral* branches spun up via `branch()`. Each entry's `pattern` must contain a `*` wildcard. Consumed by `branch()` to mint new branches, and by `pushConfig --apply-existing` to retroactively patch matching live branches.

Listing the live branches currently on a project (including ephemeral ones) is **not** part of this config — that's `neonctl branches list`.

Then either pull, push, or load connection strings:

```ts
import { fetchEnv, parseEnv, pullConfig, pushConfig } from "@neondatabase/platform/v1";
import config from "./neon";

// pull the current Neon state into a Config object (read-only on disk)
const remoteConfig = await pullConfig({ apiKey: process.env.NEON_API_KEY });

// push your local neon.ts to Neon. With no arguments it auto-loads neon.ts and
// refuses to apply if the local config conflicts with the remote project state.
await pushConfig();

// fetch live connection strings for the resolved branch (async, hits the API)
const env = await fetchEnv(config);
// env.postgres.databaseUrl           — pooled
// env.postgres.databaseUrlUnpooled   — direct

// or, if you've already injected the env vars via `neon-ts env pull` / `env run --`,
// parse them synchronously (no I/O — safe inside `drizzle.config.ts`, etc.)
const sameShape = parseEnv(config);

// force-apply, including drift on existing branches and wildcard-matched ones
await pushConfig({
  applyChanges: true,
  updateExisting: true,
  applyExisting: true,
});
```

## Public surface

`@neondatabase/platform/v1` exposes the surface in three buckets:

```ts
import {
  // Operations — what you use day-to-day
  defineConfig, pullConfig, pushConfig, fetchEnv, parseEnv, loadContext,
  loadConfigFromFile, branch, createRealNeonApi, resolveApiKey,

  // Error primitives — for instanceof / code-based checks
  PlatformError, ErrorCode,

  // Namespaces — specific error subclasses and zod schemas
  errors,   // errors.ConfigLoadError, errors.PushConflictError, …
  schemas,  // schemas.config, schemas.project, schemas.branch, schemas.branchBlueprint, schemas.computeSettings
} from "@neondatabase/platform/v1";

import type {
  // Config (used in neon.ts) — Config, ProjectConfig, BranchConfig, BranchBlueprint, ComputeSettings
  // Operation options + results — BranchOptions / BranchResult / BranchContextFile,
  //   PullConfigOptions, PushConfigOptions / PushResult, FetchEnvOptions, ParseEnvOptions, NeonEnv, …
  // NeonApi types (for custom adapters) — NeonApi, NeonBranchSnapshot, CreateBranchInput, …
  Config, BranchOptions, BranchResult, PushResult, NeonEnv, NeonApi,
} from "@neondatabase/platform/v1";
```

Internal helpers (`applyContextFileFields`, `readNeonctlCredentials`, `loadContextWithBranch`, the `Resolved*` types, …) are intentionally **not** exported.

## Project context resolution

Every SDK function and every CLI subcommand resolves `projectId`, `orgId`, and `branchId` through the **same chain**. Each row's leftmost set entry wins:

| Field       | 1st (call arg / CLI flag)              | 2nd (env)         | 3rd (`.neon/project.json`) | 4th (`.neon` file)     |
| ----------- | -------------------------------------- | ----------------- | -------------------------- | ---------------------- |
| `projectId` | `options.projectId` / `--project-id`   | `NEON_PROJECT_ID` | `projectId`                | `projectId`            |
| `orgId`     | `options.orgId` / `--org-id`           | `NEON_ORG_ID`     | `orgId`                    | `orgId`                |
| `branchId`  | `options.branch` / `--branch`[^branch] | `NEON_BRANCH_ID`  | `branchId`                 | `branchId`             |

[^branch]: Only commands that target a specific branch surface a `--branch` flag (`context`, `fetchEnv`). `pull` / `push` are branch-agnostic; `branch` *creates* a branch and produces its id as output.

The file search walks up from `cwd` (default: `process.cwd()`) until it finds either file or hits a project-root marker (`.git`, `package.json`). `.neon/project.json` is preferred over `.neon` at every directory along the walk. If nothing resolves a `projectId`, callers receive `MissingContextError`.

## API

### `defineConfig(input: Config): Config`

Validates and freezes a config using the zod-based `schemas.config`. Throws `errors.ConfigValidationError` (collecting every issue at once) when something is malformed. Pure function — no I/O.

The underlying zod schemas live under the `schemas` namespace so you can compose them into your own validation pipeline:

```ts
import { schemas } from "@neondatabase/platform/v1";

const parsed = schemas.config.safeParse(unknownInput);
if (!parsed.success) console.error(parsed.error.format());
// schemas.project / schemas.branch / schemas.branchBlueprint / schemas.computeSettings are also available
```

### `pullConfig(options?: PullConfigOptions): Promise<Config>`

Reads the live Neon project state and returns a `Config` object. The SDK call itself is **filesystem-read-only**: it never writes `.neon/project.json` or `neon.ts`. If you want to persist the result, either write it yourself or use the `neon-ts pull` CLI, which renders it as a `neon.ts` snippet and writes it into the current directory.

Concrete, persistent branches are materialised into `config.branches`. Ephemeral branches (those with a future `expiresAt`) are **dropped** — listing live branches at runtime is `neonctl branches list`'s job, not config-as-code's. Likewise pull never emits a `branchBlueprints` section: blueprints are templates that live in your editable `neon.ts`, not on Neon.

Project resolution follows the standard chain — see [Project context resolution](#project-context-resolution). Throws `errors.MissingContextError` if no project id can be resolved.

### `pushConfig(...): Promise<PushResult>`

Three overloads:

```ts
pushConfig();                          // auto-load neon.ts, fail on conflict
pushConfig(options);                   // auto-load neon.ts, configurable behaviour
pushConfig(config, options?);          // use an already-validated Config object
```

Important options:

| Option            | Default | Effect                                                                                                                                                |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyChanges`    | `false` | When `false`, push fails (`PushConflictError`) if any field-level conflict is detected. When `true`, push patches the remote regardless.              |
| `updateExisting`  | `false` | When `true`, settings / `protected` drift on `config.branches` entries (e.g. `production`) is applied to the existing branch instead of failing.      |
| `applyExisting`   | `false` | When `true`, `branchBlueprints` entries (wildcard patterns like `preview-*`) apply their settings/TTL to **every matching existing branch**.          |

`pushConfig` will create a project if none exists in the resolved org/name combination and `project.region` is set. Region and Postgres major version are immutable on Neon — pushing a different value surfaces a `ConflictReport`.

### Env: `fetchEnv` / `parseEnv` / `NeonEnv<Config>`

Both functions return a namespaced, statically-typed value whose shape is **derived from `config.features`** — `postgres` is always present; `auth` and `dataApi` are added to the type iff the matching flag is set:

```ts
const config = defineConfig({
  project: { name: "my-app" },
  branches: { production: {} },
  features: { auth: true, dataApi: true },   // ← drives the env type
});

const env = parseEnv(config);
// env.postgres.databaseUrl              — pooled, always present
// env.postgres.databaseUrlUnpooled      — direct, always present
// env.auth.projectId                    — present because features.auth
// env.auth.publishableClientKey
// env.auth.secretServerKey
// env.auth.jwksUrl
// env.dataApi.url                       — present because features.dataApi
```

`defineConfig` is declared with a `const` generic so the literal flag flows through to `NeonEnv<typeof config>`. When a feature is `false` (or absent), its namespace is dropped from both the static type and the runtime validation — your app can't accidentally read `env.auth` for a project that doesn't enable it.

Pick whichever matches your runtime constraints:

| Function | When | I/O | Notes |
| -------- | ---- | --- | ----- |
| `await fetchEnv(config)` | Build scripts, CLIs, anywhere top-level await is fine | Calls the Neon API every call | Resolves the branch via the standard chain; returns the live `NeonEnv` |
| `parseEnv(config)`       | Application bootstrap, `drizzle.config.ts`, framework configs where async isn't allowed | None — reads `process.env` synchronously, validates with zod | Throws `PLATFORM_ENV_NOT_INJECTED` listing what's missing; pair with `neon-ts env pull` / `neon-ts env run` to inject the vars |

```ts
// drizzle.config.ts — no async allowed, so use parseEnv
import { defineConfig } from "drizzle-kit";
import { parseEnv } from "@neondatabase/platform/v1";
import config from "./neon";

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: parseEnv(config).postgres.databaseUrlUnpooled },
  schema: "./src/schema.ts",
});
```

```ts
// app bootstrap — async-friendly, fetch fresh from the API
import { fetchEnv } from "@neondatabase/platform/v1";
import config from "./neon";

const env = await fetchEnv(config);
const db = drizzle(neon(env.postgres.databaseUrl), { schema });
```

For `fetchEnv`: `projectId`, `orgId`, and `branch` follow the standard [Project context resolution](#project-context-resolution) chain, with one extra fallback for `branch` only — when nothing resolves it, the first key in `config.branches` (typically `"production"`) is used. `roleName` and `databaseName` are auto-picked when the branch has exactly one role / database; otherwise `fetchEnv` throws `PLATFORM_AMBIGUOUS_BRANCH_AUTH` and you'll need to pass `databaseName` explicitly.

For `parseEnv`: the OS-level env-var keys are exposed as `NEON_ENV_VAR_KEYS` for callers building their own pull/inject tooling. Current mapping:

| `NeonEnv` path                       | env-var key                          | when                |
| ------------------------------------ | ------------------------------------ | ------------------- |
| `postgres.databaseUrl`               | `DATABASE_URL`                       | always              |
| `postgres.databaseUrlUnpooled`       | `DATABASE_URL_UNPOOLED`              | always              |
| `auth.projectId`                     | `NEON_AUTH_PROJECT_ID`               | `features.auth`     |
| `auth.publishableClientKey`          | `NEON_AUTH_PUBLISHABLE_CLIENT_KEY`   | `features.auth`     |
| `auth.secretServerKey`               | `NEON_AUTH_SECRET_SERVER_KEY`        | `features.auth`     |
| `auth.jwksUrl`                       | `NEON_AUTH_JWKS_URL`                 | `features.auth`     |
| `dataApi.url`                        | `NEON_DATA_API_URL`                  | `features.dataApi`  |

For `fetchEnv` with `features.auth`: the public bits (`projectId`, `jwksUrl`) are fetched fresh from the Neon API (`GET /projects/:pid/branches/:bid/auth`). The secret bits (`publishableClientKey`, `secretServerKey`) are **not** refetchable — Neon only returns them at integration-creation time — so `fetchEnv` reads them from `process.env` and throws `PLATFORM_ENV_NOT_INJECTED` if they aren't there. Pull them once at create time (via the Neon Console / `npx neonctl auth …`) and feed them through your hosting platform's secret store.

The return shape is **fixed** on purpose — the point of `fetchEnv`/`parseEnv` is to be a typed escape hatch from `.env` files: one `import config from "./neon"`, one `parseEnv(config)`, and the rest of your app talks to `env.postgres.databaseUrl` directly. Future namespaces (`env.vector`, `env.s3`, …) can be added alongside `postgres` without breaking the existing surface.

This call is **read-only**: it never mutates `process.env`, writes to disk, or modifies the remote Neon project. Two `getConnectionUri` API calls (pooled + direct) plus one `listBranches` and one each of `listBranchRoles` / `listBranchDatabases`.

Throws `errors.MissingContextError`, or a `PlatformError` with code `PLATFORM_MISSING_API_KEY`, `PLATFORM_BRANCH_NOT_FOUND`, or `PLATFORM_AMBIGUOUS_BRANCH_AUTH` depending on what's underspecified — see [Error reference](#error-reference) below.

### `loadContext(options?: LoadContextOptions): NeonContext`

Resolves the Neon project and (optionally) branch this process should target via the [standard chain](#project-context-resolution). Pure helper — does no network calls and never writes to disk.

Throws `errors.MissingContextError` when no project id can be resolved. `branch` is optional — when the operation downstream needs a branch, check `ctx.branch` and throw your own error.

```ts
import { loadContext } from "@neondatabase/platform/v1";

const ctx = loadContext({ branch: "preview-pr-42" });
// ctx.projectId         "proj-cool-name-123"
// ctx.orgId              "org-abc-456"
// ctx.branch             { kind: "name", value: "preview-pr-42" }
// ctx.sourcePath         "/repo/.neon/project.json"
```

### `branch(options: BranchOptions): Promise<BranchResult>`

Create a single ephemeral branch from a wildcard blueprint defined in `neon.ts`. This is the "I'm starting a new feature, give me a dedicated database" entry point — exactly one branch per call, named after your git branch when available, with the blueprint's TTL and compute settings applied.

```ts
import { branch } from "@neondatabase/platform/v1";

const result = await branch({ blueprint: "preview" });
// → {
//     branchName: "preview-andre-feature-a1b2c3",
//     branchId: "br-...",
//     projectId: "proj-...",
//     parentBranchName: "production",
//     contextFile: { status: "updated", path: "/repo/.neon/project.json", json: "{...}", data: {...} },
//   }
```

Behaviour:

1. **Project context** is resolved via the standard chain (see [Project context resolution](#project-context-resolution)). Throws `errors.MissingContextError` if no project id is resolvable.
2. **`neon.ts`** is loaded via `loadConfigFromFile`. Throws `errors.ConfigLoadError` if missing.
3. The **blueprint** identified by `options.blueprint` must exist in `config.branchBlueprints`. (Patterns are validated at `defineConfig` time to ensure they contain a `*` wildcard.) Passing the name of a concrete branch (entry in `config.branches` like `"production"`) throws a `PlatformError` with code `PLATFORM_INVALID_CONFIG` along with a pointer to use `pushConfig` instead.
4. The **branch name** is composed as `<pattern>` with `*` substituted by:
   - `<normalised-git-branch>-<mini-id>` when git is available (e.g. `andre/new-feat` → `andre-new-feat-a1b2c3`), or
   - just `<mini-id>` (6 hex chars) when not. Pass `gitBranch: null` to opt out of the git lookup explicitly, or `gitBranch: "my-name"` to inject one.
5. On name **collision** with an existing branch the mini-id is re-rolled up to `maxAttempts` times (default 10).
6. The branch is **created on Neon** with the blueprint's `parent`, `ttl`, and `computeSettings` applied. Parent branches must exist on Neon (run `pushConfig` first if not) — otherwise `PLATFORM_MISSING_PARENT_BRANCH`.
7. The **project-context file is updated** (in place) so subsequent `fetchEnv` / `pullConfig` calls target the new branch. The outcome is reported via `result.contextFile.status`:

   | `status`        | When                                                                  | Extra fields            |
   | --------------- | --------------------------------------------------------------------- | ----------------------- |
   | `updated`       | `.neon/project.json` (preferred) or `.neon` existed and was rewritten | `path`                  |
   | `no-file`       | Neither file existed; nothing was written                             | —                       |
   | `write-failed`  | A file existed but the write itself failed (read-only FS, EACCES, …)  | `path`, `error`         |

   `json` and `data` are always populated regardless of status, so you can apply the update by hand. `branch()` never *creates* a new context file — write `result.contextFile.json` to `.neon/project.json` yourself if you want to bootstrap one.

### `loadConfigFromFile(options?: LoadConfigOptions): Promise<{ config: Config; resolvedPath: string }>`

Find and load a `neon.ts` (or `.mts` / `.js` / `.mjs`) from disk, validate it via `defineConfig`, and return both the parsed config and the absolute path it was loaded from.

This is the same loader `pushConfig()` calls internally — exposed so callers can validate or inspect a config without pushing it (e.g. CI lint steps, custom CLIs, hand-rolled tooling).

Resolution rules:

- When `options.path` is set, that file is loaded directly. The path may be absolute or relative to `options.cwd ?? process.cwd()`.
- When `options.path` is omitted, the loader walks up from `options.cwd ?? process.cwd()` looking for the first file matching `neon.ts`, `neon.mts`, `neon.js`, or `neon.mjs`. The walk stops at the first directory containing a `package.json` or `.git`.

`.ts` / `.mts` / `.cts` files are loaded via [`jiti`](https://github.com/unjs/jiti) (zero-config runtime TypeScript). `.js` / `.mjs` files use Node's native dynamic `import`. Either way, the file must `export default defineConfig(...)`. Module objects that look like a `Config` (have a `project` property) are also accepted as a convenience.

```ts
import { loadConfigFromFile } from "@neondatabase/platform/v1";

// Walks up from cwd looking for neon.ts / .mts / .js / .mjs.
const { config, resolvedPath } = await loadConfigFromFile();
console.log(`loaded ${resolvedPath}: project=${config.project.name}`);

// Or pass an explicit path:
const { config: ciConfig } = await loadConfigFromFile({
  path: "./configs/staging.neon.ts",
});
```

Throws `errors.ConfigLoadError` when the file can't be found / evaluated / lacks a default export, and `errors.ConfigValidationError` when the loaded object fails schema validation. Both extend `PlatformError` — see the [Error reference](#error-reference) below.

## CLI

The package ships a `neon-ts` binary (analogous to `neon-init`) that wraps the SDK so the same commands can be exercised in isolation before they are wired into `neonctl`.

```bash
# Once installed (locally or via npx):
neon-ts --help

# Print the resolved project + branch context as JSON
neon-ts context

# Pull the live state of the project into a neon.ts file in the current directory
neon-ts pull                                         # writes/overwrites ./neon.ts
neon-ts pull --format json --project-id proj-...     # prints raw Config JSON to stdout instead

# Push your local neon.ts to the resolved Neon project
neon-ts push                                # fail on conflict
neon-ts push --update-existing              # update existing specific-name branches
neon-ts push --apply-existing               # apply wildcard blueprints to existing matching branches
neon-ts push --apply-changes                # force-apply, ignoring branch-level conflicts

# Create an ephemeral branch from a wildcard blueprint
neon-ts branch preview                      # creates `preview-<git-branch>-<mini-id>`
neon-ts branch preview --project-id proj-x  # override the resolved project id

# Pull live connection strings into a .env file (default: .env.local). The file format
# matches what frameworks like Next.js / Vite / Drizzle Kit auto-load. Run this once after
# `neon-ts branch` or `neonctl link` and your app can read DATABASE_URL the normal way.
neon-ts env pull                            # writes ./.env.local
neon-ts env pull .env                       # write somewhere else
neon-ts env pull --branch preview-andre     # override the resolved branch

# Run a command with Neon env vars injected on top of the current `process.env`. Use `--`
# to separate the wrapped command. The child inherits stdio so dev servers stay
# interactive; the parent exits with the child's exit code.
neon-ts env run -- npm run dev
neon-ts env run --branch preview-andre -- pnpm test
```

Exit codes (stable — branch on these in CI / shell pipelines):

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | Success                                                                              |
| 1    | Generic error / missing `NEON_API_KEY`                                               |
| 2    | `errors.PushConflictError` (re-run with `--apply-changes` / `--update-existing`)     |
| 3    | `errors.MissingContextError` (no project id resolvable from args, env, or `.neon[/project.json]`) |
| 4    | `errors.ConfigLoadError` (couldn't find / load `neon.ts`)                            |
| 5    | Other `PlatformError`                                                                |
| 6    | `PLATFORM_UNAUTHORIZED` — bad / expired / revoked API key                            |
| 7    | `PLATFORM_FORBIDDEN` or `PLATFORM_INSUFFICIENT_SCOPE` — key lacks required scope     |
| 8    | `PLATFORM_NOT_FOUND` — project / branch / endpoint doesn't exist                     |
| 9    | `PLATFORM_RATE_LIMITED` — back off and retry                                         |
| 10   | `PLATFORM_NETWORK_ERROR` — could not reach the Neon API                              |
| 11   | `PLATFORM_SERVER_ERROR` or `PLATFORM_LOCKED` — Neon returned 5xx, or still locked    |
| 99   | `PLATFORM_INTERNAL_ERROR` — a bug in this package; please file an issue              |

Pass `--debug` to any subcommand to print stack traces, error codes, and structured details (request ids, neon API messages) on stderr.

All flags accept env-var fallbacks: `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_ORG_ID`, `NEON_BRANCH_ID`.

## Error reference

Every error this package throws extends `PlatformError`. The `code` field is the stable identifier — match on it programmatically rather than parsing free-text messages:

```ts
import { ErrorCode, PlatformError, errors } from "@neondatabase/platform/v1";

try { await pushConfig(); }
catch (err) {
  if (err instanceof errors.PushConflictError) {
    // Structured access: err.conflicts has each ConflictReport with current/desired/reason.
    console.error(err.conflicts);
  } else if (err instanceof PlatformError && err.code === ErrorCode.NotFound) {
    // Code-based check for the wrapped HTTP errors that don't have dedicated subclasses.
  }
}
```

The specific subclasses (`ConfigLoadError`, `ConfigValidationError`, `MissingContextError`, `PushConflictError`) live under the `errors` namespace; the table below lists every `ErrorCode`.

| Code                              | When it fires                                                                   | What to do                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_INVALID_CONFIG`         | `defineConfig` / the zod schema rejected your config, or `branch()` was called with the name of a concrete branch instead of a wildcard blueprint | Read the aggregated issue list in `err.issues` and fix each one                                                  |
| `PLATFORM_ENV_NOT_INJECTED`       | `parseEnv` couldn't find the required Neon env vars in `process.env`            | Run `neon-ts env pull` to write `.env.local`, or wrap your dev command with `neon-ts env run -- <cmd>`. Or switch to `await fetchEnv(config)` if you can do async I/O. |
| `PLATFORM_MISSING_CONTEXT`        | No project id resolvable from args, env, or context file                        | Pass `projectId` / `--project-id`, set `NEON_PROJECT_ID`, or run `npx neonctl set-context --project-id <id>`     |
| `PLATFORM_PUSH_CONFLICT`          | Local config differs from remote (and you didn't opt into apply)                | The thrown `errors.PushConflictError` lists each conflict with a `fix` hint. Most resolve via `updateExisting: true` |
| `PLATFORM_CONFIG_LOAD_FAILED`     | `neon.ts` is missing, has a syntax error, or doesn't `export default`           | Path is in the message. Run the file directly (`npx tsx neon.ts`) to reproduce the underlying error              |
| `PLATFORM_MISSING_API_KEY`        | No API key in `apiKey` option or `NEON_API_KEY` env                             | Generate one at <https://console.neon.tech/app/settings/api-keys>                                                |
| `PLATFORM_AMBIGUOUS_PROJECT`      | Multiple projects with the same name (org-/user-scoped key without `projectId`) | Pass `projectId` to pick one — the candidate ids are in `err.details.candidateProjectIds`                        |
| `PLATFORM_AMBIGUOUS_BRANCH_AUTH`  | `fetchEnv` found multiple roles / databases on the branch and can't auto-pick    | Pass `roleName` / `databaseName` — available values are in `err.details.availableRoles` / `availableDatabases`   |
| `PLATFORM_BRANCH_NOT_FOUND`       | `fetchEnv` couldn't find the requested branch / role / database on the project   | Check the name; available values are in `err.details.available`                                                  |
| `PLATFORM_REGION_REQUIRED`        | First-time create but `project.region` is missing                               | Add a region (e.g. `aws-us-east-1`) to your config                                                               |
| `PLATFORM_INSUFFICIENT_SCOPE`     | Project-scoped key tried to list projects                                       | Pass `projectId` explicitly, or use an org/user-scoped key                                                       |
| `PLATFORM_MISSING_PARENT_BRANCH`  | Push tried to create a branch whose parent doesn't exist on Neon                | Either define the parent as a blueprint too, or change the blueprint's `parent` to an existing branch           |
| `PLATFORM_UNAUTHORIZED`           | Neon returned 401 — bad / expired key                                           | Rotate the key                                                                                                   |
| `PLATFORM_FORBIDDEN`              | Neon returned 403 — key lacks the right scope for the operation                 | Use the appropriate key scope (org for listing, project for single-project ops)                                  |
| `PLATFORM_NOT_FOUND`              | Neon returned 404 — the resource doesn't exist or your key can't see it         | Check the id in `err.message` / `err.details`                                                                    |
| `PLATFORM_CONFLICT`               | Neon returned 409 — a conflicting resource already exists                       | Often a name collision; pull first to compare                                                                    |
| `PLATFORM_RATE_LIMITED`           | Neon returned 429                                                               | Back off and retry; if persistent, contact support with `err.details.requestId`                                  |
| `PLATFORM_LOCKED`                 | Neon returned 423 even after the built-in retry budget                          | Wait a few seconds and retry; raise `retryOnLocked.maxAttempts` if persistent                                    |
| `PLATFORM_SERVER_ERROR`           | Neon returned 5xx                                                               | Usually transient; check <https://neonstatus.com> and the request id in `err.details.requestId`                  |
| `PLATFORM_NETWORK_ERROR`          | Transport-level failure (DNS, refused, timeout, …)                              | Check your network connectivity to `https://console.neon.tech`                                                   |
| `PLATFORM_INTERNAL_ERROR`         | An invariant in this package was violated                                       | Please file an issue at <https://github.com/neondatabase/neon-pkgs/issues>                                       |

Every wrapped HTTP error carries structured context in `err.details`:

- `op` — the SDK method that was attempted (`getProject(proj-foo)`, `createBranch(proj-foo/staging)`, …)
- `status` — the HTTP status code
- `projectId` — the project id when the operation is project-scoped
- `requestId` — Neon's `X-Request-Id` for support tickets
- `neonMessage` / `neonCode` — the raw error message and code from the Neon API response body

## Filesystem contract

The **SDK** is filesystem-read-only with one exception: `branch()` updates an existing project-context file's `branchId` in place after creating an ephemeral branch (so subsequent `fetchEnv` / `pullConfig` calls target it). The write is attempted *safely* — a read-only filesystem or permission error is reported as `contextFile.status === "write-failed"` rather than crashing the call, and the JSON payload is still returned so the user can apply it by hand. All other public SDK functions — `pullConfig`, `pushConfig`, `fetchEnv`, `loadContext`, `loadConfigFromFile`, `defineConfig` — never touch disk.

Project-context files (`.neon/project.json` or the neonctl `.neon` file) themselves are **never created** by the SDK; bootstrap one with `neon set-context` or any other tool of your choice before calling `branch()`.

The **`neon-ts` CLI** is the one place that does write `neon.ts` for you: `neon-ts pull` writes (or overwrites) `./neon.ts` so you can start editing immediately. Pass `--format json` to get the raw `Config` on stdout instead (read-only). `neon-ts push`, `neon-ts context`, and `neon-ts branch` only ever read `neon.ts` and never modify it.

## Authentication

The package resolves the Bearer token sent to the Neon API through a 3-step chain (each entry wins over the next):

| Step | Source                                                  | When to use                                                                                                  |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | `apiKey` SDK option / `--api-key` CLI flag              | One-off scripts; injecting a test fixture                                                                    |
| 2    | `NEON_API_KEY` environment variable                     | Standard config — CI, `.env` files, shell env                                                                |
| 3    | `access_token` in `~/.config/neonctl/credentials.json`  | Local dev — after running `npx neonctl auth` you get the SDK / CLI working with zero extra config            |

The third step works the same way `neonctl` itself does: it reads the OAuth access token written by `npx neonctl auth` and uses it as a Bearer token for the management API. It also honours `NEONCTL_CONFIG_DIR` for picking up credentials from a non-default location, and falls back to `USERPROFILE` on Windows.

Two things to know about the credentials-file fallback:

- **OAuth tokens expire.** Unlike `napi_*` API keys, the access token in `credentials.json` has a TTL (refreshed in-process by `neonctl` on every invocation, but we don't run that refresh flow). When the token expires you'll get `PLATFORM_UNAUTHORIZED` from the next API call — the error message tells you to either rotate an API key or re-run `npx neonctl auth`.
- **Token source is exposed.** `resolveApiKey()` returns `{ token, source: "option" | "env" | "neonctl" }` so callers can log / branch on where the token came from.

```ts
import { resolveApiKey } from "@neondatabase/platform/v1";

const resolved = resolveApiKey();
if (!resolved) throw new Error("set NEON_API_KEY or run `npx neonctl auth`");
console.log(`using token from ${resolved.source}`);
```

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

1. Create `packages/platform/.env` (gitignored) from `.env.example` and put an **org-scoped** API key in `NEON_API_KEY`. The org should be empty (or at least not contain projects named `neon-ts-e2e-*`).
2. The suite runs single-threaded with 120s per-test timeouts.
3. A startup sweep deletes any orphaned `neon-ts-e2e-*` projects from a previous failed run.
4. Each test names its project `neon-ts-e2e-<uuid>-<purpose>` and registers it for cleanup, even if the test fails mid-way.

Tests skip the "create project" portions when only a project-scoped key is available; set `NEON_PROJECT_ID` in `.env` to point the bounded subset at an existing project.

## Testing your IaC

Inject a custom `api` (any object implementing `NeonApi`) to test pull/push flows without hitting the real Neon API. The package ships its public `NeonApi` interface so you can build your own fakes — internally, the test suite uses an in-memory fake (not vendored to consumers) that exercises the same interface.

```ts
import type { NeonApi } from "@neondatabase/platform/v1";
import { pushConfig } from "@neondatabase/platform/v1";

const api: NeonApi = /* your fake */;
await pushConfig(myConfig, { api, projectId: "proj-test" });
```
