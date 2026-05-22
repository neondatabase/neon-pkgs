# @neondatabase/platform

IaC and Config-as-Code for the Neon Platform. Describe your project, branch blueprints, TTLs, and compute settings in a single `neon.ts` file at the root of your repo, then `pullConfig` / `pushConfig` to sync against the [Neon API](https://api-docs.neon.tech).

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
  branchBlueprints: {
    production: {
      computeSettings: {
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 2,
        suspendTimeout: "5m",
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

Then either pull, push, or load connection strings:

```ts
import { loadEnv, pullConfig, pushConfig } from "@neondatabase/platform/v1";
import config from "./neon";

// pull the current Neon state into a Config object (read-only on disk)
const remoteConfig = await pullConfig({ apiKey: process.env.NEON_API_KEY });

// push your local neon.ts to Neon. With no arguments it auto-loads neon.ts and
// refuses to apply if the local config conflicts with the remote project state.
await pushConfig();

// load DATABASE_URL + DATABASE_URL_UNPOOLED for the current branch
const env = await loadEnv(config);
Object.assign(process.env, env);

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

### `loadEnv(config: Config, options?: LoadEnvOptions): Promise<Record<string, string>>`

Fetch Postgres connection strings for the project + branch this process should target, ready to spread into `process.env` or write to a `.env` file. Returns:

```ts
{ DATABASE_URL: "postgres://…-pooler…?sslmode=require",
  DATABASE_URL_UNPOOLED: "postgres://…?sslmode=require" }
```

Typical usage at the top of an application bootstrap or build script:

```ts
import { loadEnv } from "@neondatabase/platform/v1";
import config from "./neon";

const env = await loadEnv(config);
Object.assign(process.env, env);
```

Resolution chain — each entry wins over the next:

| Field          | 1st (call args)        | 2nd (env)         | 3rd (file)                            | 4th (config)                       |
| -------------- | ---------------------- | ----------------- | ------------------------------------- | ---------------------------------- |
| `projectId`    | `options.projectId`    | `NEON_PROJECT_ID` | `projectId` in `.neon[/project.json]` | — (throws `MissingContextError`)   |
| `branch`       | `options.branch`       | `NEON_BRANCH_ID`  | `branchId` in `.neon[/project.json]`  | first key in `branchBlueprints`    |
| `roleName`     | `options.roleName`     | —                 | —                                     | auto-picked when branch has one    |
| `databaseName` | `options.databaseName` | —                 | —                                     | auto-picked when branch has one[^1] |

[^1]: When the branch has multiple databases but only one is owned by the resolved role, that one is auto-picked. Otherwise `loadEnv` throws `PLATFORM_AMBIGUOUS_BRANCH_AUTH` and you'll need to pass `databaseName` explicitly.

Override the output env-var keys to match Vercel's / Cloudflare's conventions:

```ts
const env = await loadEnv(config, {
  databaseUrlKey: "POSTGRES_URL",
  databaseUrlUnpooledKey: "POSTGRES_URL_NON_POOLING",
});
```

This call is **read-only**: it never mutates `process.env`, writes to disk, or modifies the remote Neon project. Two `getConnectionUri` API calls (pooled + direct) plus one `listBranches` and one each of `listBranchRoles` / `listBranchDatabases`.

Throws `MissingContextError`, `PLATFORM_MISSING_API_KEY`, `PLATFORM_BRANCH_NOT_FOUND`, or `PLATFORM_AMBIGUOUS_BRANCH_AUTH` depending on what's underspecified — see [Error reference](#error-reference) below.

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

### `loadConfigFromFile(options?: LoadConfigOptions): Promise<{ config: Config; resolvedPath: string }>`

Find and load a `neon.ts` (or `.mts` / `.js` / `.mjs`) from disk, validate it via `defineConfig`, and return both the parsed config and the absolute path it was loaded from.

This is the same loader `pushConfig()` calls internally — exposed so callers can validate or inspect a config without pushing it (e.g. CI lint steps, custom CLIs, hand-rolled tooling).

Resolution rules:

- When `options.path` is set, that file is loaded directly. The path may be absolute or relative to `options.cwd ?? process.cwd()`.
- When `options.path` is omitted, the loader walks up from `options.cwd ?? process.cwd()` looking for the first file matching `DEFAULT_CONFIG_FILENAMES` (`neon.ts`, `neon.mts`, `neon.js`, `neon.mjs`). The walk stops at the first directory containing a `package.json` or `.git`.

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

Throws `ConfigLoadError` when the file can't be found / evaluated / lacks a default export, and `ConfigValidationError` when the loaded object fails schema validation. Both extend `PlatformError` — see the [Error reference](#error-reference) below.

## CLI

The package ships a `neon-ts` binary (analogous to `neon-init`) that wraps the SDK so the same commands can be exercised in isolation before they are wired into `neonctl`.

```bash
# Once installed (locally or via npx):
neon-ts --help

# Print the resolved project + branch context as JSON
neon-ts context

# Pull the live state of the project into a neon.ts snippet (default) or JSON
neon-ts pull
neon-ts pull --format json --project-id proj-cool-snow-123

# Push your local neon.ts to the resolved Neon project
neon-ts push                                # fail on conflict
neon-ts push --update-existing              # update existing specific-name branches
neon-ts push --apply-existing               # apply wildcard blueprints to existing matching branches
neon-ts push --apply-changes                # force-apply, ignoring branch-level conflicts
```

Exit codes (stable — branch on these in CI / shell pipelines):

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | Success                                                                              |
| 1    | Generic error / missing `NEON_API_KEY`                                               |
| 2    | `PushConflictError` (re-run with `--apply-changes` / `--update-existing`)            |
| 3    | `MissingContextError` (no project id resolvable from args, env, or `.neon[/project.json]`) |
| 4    | `ConfigLoadError` (couldn't find / load `neon.ts`)                                   |
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

Every error this package throws extends `PlatformError`. The `code` field is the stable identifier — match on it programmatically (`if (err instanceof PlatformError && err.code === ErrorCode.NotFound)`) rather than parsing free-text messages.

| Code                              | When it fires                                                                   | What to do                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_INVALID_CONFIG`         | `defineConfig` / the zod schema rejected your config                            | Read the aggregated issue list in `err.issues` and fix each one                                                  |
| `PLATFORM_MISSING_CONTEXT`        | No project id resolvable from args, env, or context file                        | Pass `projectId` / `--project-id`, set `NEON_PROJECT_ID`, or run `npx neonctl set-context --project-id <id>`     |
| `PLATFORM_PUSH_CONFLICT`          | Local config differs from remote (and you didn't opt into apply)                | The thrown `PushConflictError` lists each conflict with a `fix` hint. Most resolve via `updateExisting: true`    |
| `PLATFORM_CONFIG_LOAD_FAILED`     | `neon.ts` is missing, has a syntax error, or doesn't `export default`           | Path is in the message. Run the file directly (`npx tsx neon.ts`) to reproduce the underlying error              |
| `PLATFORM_MISSING_API_KEY`        | No API key in `apiKey` option or `NEON_API_KEY` env                             | Generate one at <https://console.neon.tech/app/settings/api-keys>                                                |
| `PLATFORM_AMBIGUOUS_PROJECT`      | Multiple projects with the same name (org-/user-scoped key without `projectId`) | Pass `projectId` to pick one — the candidate ids are in `err.details.candidateProjectIds`                        |
| `PLATFORM_AMBIGUOUS_BRANCH_AUTH`  | `loadEnv` found multiple roles / databases on the branch and can't auto-pick    | Pass `roleName` / `databaseName` — available values are in `err.details.availableRoles` / `availableDatabases`   |
| `PLATFORM_BRANCH_NOT_FOUND`       | `loadEnv` couldn't find the requested branch / role / database on the project   | Check the name; available values are in `err.details.available`                                                  |
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

## Read-only filesystem contract

The package never creates, updates, or deletes files. In particular it does **not** write `.neon/project.json`. To bootstrap a project-context file, use `neon set-context` (which writes `.neon`) or any other tool of your choice. This package will happily read both layouts.

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
