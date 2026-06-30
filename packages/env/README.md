# @neon/env

Resolve and inject Neon connection strings for the branch selected by your `neon.ts` policy. Exposes `fetchEnv` / `parseEnv` functions plus a `neon-env` CLI with `run` (inject env into a command) and `export` (print env to stdout).

Builds on [`@neon/config`](../config) — it reuses the `Config` policy type and the Neon API client.

## Install

```bash
npm install @neon/env
```

## Functions

The library functions are **filesystem- and env-agnostic**: `fetchEnv` requires an explicit `projectId` + `branch` (a branch **name** like `main`, or a `br-…` id). (The `neon-env` CLI does the `.neon`/`NEON_*` resolution and passes these in.)

> `parseEnv` takes **no branch name**: the secret set is static (top-level `config.auth` / `config.dataApi`), so it reads those toggles directly without evaluating the per-branch closure. Its optional second argument is a **scope** _or_ a **key filter** — omit it for the full external (app/build) env, pass a **function slug** when running inside that deployed function (adds a typed `function` namespace of its declared env keys), or pass an **array of OS-level env-var keys** to require + return only that subset.

```ts
import config from "../neon";
import { fetchEnv, parseEnv } from "@neon/env";

// Async — calls the Neon API for live connection strings. Use in build scripts / top-level await.
const env = await fetchEnv(config, { projectId: "patient-art-12345", branch: "main" });
const db = drizzle(neon(env.postgres.databaseUrl), { schema });

// Sync — reads already-injected process.env and validates it (no network).
// Use in app bootstrap where async isn't available.
const env2 = parseEnv(config);

// Inside a deployed function, pass its slug for the typed `function` namespace:
const fnEnv = parseEnv(config, "hello");
fnEnv.function.resendApiKey; // typed from hello's declared env keys

// Key filter — only enforce + return the vars you actually use (e.g. a Next.js app that
// reads the pooled URL but not the unpooled one). The keys autocomplete from the policy, so
// you can only select vars the policy enables, and the result is narrowed to match:
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
postgres.databaseUrl; // string — `databaseUrlUnpooled` is absent, and never required
```

Both return the same namespaced `NeonEnv` shape: `postgres` is always present; `branch` (the branch name, surfaced as `NEON_BRANCH`) is always present on a `fetchEnv` result and present on a `parseEnv` result when `NEON_BRANCH` was injected; `auth` and `dataApi` are included (and statically typed) when the evaluated branch policy enables them.

| Function | Description |
| --- | --- |
| `fetchEnv(config, { projectId, branch, ... })` | Async. Calls the Neon API for the given project + branch and returns live connection strings (and Auth/Data API values when enabled). `projectId` and `branch` are required; `branch` accepts a branch **name** (e.g. `main`) or a `br-…` id. (The legacy id-only `branchId` option still works.) |
| `parseEnv(config)` / `parseEnv(config, slug)` / `parseEnv(config, keys)` | Sync. Reads/validates the Neon env vars already present in `process.env` against the static policy toggles. With a function `slug`, also returns a typed `function` namespace of that function's declared env keys. With a `keys` array (e.g. `["DATABASE_URL"]`), only those vars are required and returned, as a narrowed namespaced shape — the keys are typesafe against the policy. Throws `PlatformError(EnvNotInjected)` listing missing vars when the env isn't populated. |
| `toEntries(env)` | Project a resolved `NeonEnv` into `{ KEY: value }` pairs for cross-process transport (named after the web `.entries()` convention; returns a `Record`). |

## CLI

### `run` — inject env into a command

Inject the env vars for your `neon.ts` branch into a dev command:

```bash
neon-env run -- npm run dev
neon-env run -- pnpm dev
```

`run` loads `neon.ts`, resolves the branch (via `--branch`, `NEON_BRANCH` / `NEON_BRANCH_ID`, or the `branch` field in `.neon[/project.json]` — by name or id), fetches the connection strings from Neon, and spawns the command with `NEON_BRANCH` / `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (and `NEON_AUTH_BASE_URL` / `NEON_AUTH_JWKS_URL` / `NEON_DATA_API_URL` when the policy enables them) injected on top of the inherited environment. Stdio is inherited so interactive dev servers keep working, and the parent exits with the child's exit code.

### `export` — print env to stdout

Resolve the same branch env, but print it instead of spawning a process — for piping into other env tools:

```bash
neon-env export                 # dotenv KEY=value lines (default)
neon-env export --format json   # JSON object
```

For example, [varlock](https://varlock.dev) can bulk-load Neon's branch env via its `exec()` resolver:

```bash
# .env.schema
# @setValuesBulk(exec(`neon-env export --format json`), format=json)
```

Flags (both commands): `--config <path>`, `--project-id`, `--branch`, `--api-key`, `--debug`. `export` also takes `--format dotenv|json`.

## Env vars produced

| Key | From |
| --- | --- |
| `NEON_BRANCH` | the resolved branch **name** — mirrors what the Neon Functions runtime injects on every branch, so local dev matches the deployed runtime |
| `DATABASE_URL` | pooled connection string |
| `DATABASE_URL_UNPOOLED` | direct connection string |
| `NEON_AUTH_BASE_URL` | Neon Auth integration (when `auth` is enabled) |
| `NEON_AUTH_JWKS_URL` | Neon Auth JWKS endpoint for verifying issued tokens (when `auth` is enabled) |
| `NEON_DATA_API_URL` | Data API integration (when `dataApi` is enabled) |

## Resolution

The **CLI** (`neon-env run`) resolves project + branch itself: `--project-id` / `--branch` flag → `NEON_PROJECT_ID` / `NEON_BRANCH` (name) / `NEON_BRANCH_ID` (legacy id) env → `.neon[/project.json]` walked up from the working directory (its `branch` field, name or id; legacy `branchId` still read). The API key resolves via `--api-key` → `NEON_API_KEY` → `~/.config/neonctl/credentials.json`.

The **library functions** do none of this — pass `projectId` / `branch` explicitly. This keeps `.neon` parsing in one place (the CLI / neonctl) and the functions pure.
