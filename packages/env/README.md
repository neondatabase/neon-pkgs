# @neondatabase/env

Resolve and inject Neon connection strings for the branch selected by your `neon.ts` policy. Exposes `fetchEnv` / `parseEnv` functions plus a single CLI command: `neon-env run -- <cmd>`.

Builds on [`@neondatabase/config`](../config) — it reuses the `Config` policy type and the Neon API client.

## Install

```bash
npm install @neondatabase/env
```

## Functions

The library functions are **filesystem- and env-agnostic**: `fetchEnv` requires an explicit `projectId` + `branchId`, and `parseEnv` requires an explicit `branchName`. (The `neon-env` CLI does the `.neon`/`NEON_*` resolution and passes these in.)

> `parseEnv` takes a branch **name**, not an id, because it makes no API call — it only needs the branch to evaluate your `neon.ts` policy, which switches on `branch.name`. The API-backed functions take a `branchId` (`br-…`) and read the name back from Neon.

```ts
import config from "../neon";
import { fetchEnv, parseEnv } from "@neondatabase/env/v1";

// Async — calls the Neon API for live connection strings. Use in build scripts / top-level await.
const env = await fetchEnv(config, { projectId: "patient-art-12345", branchId: "br-…" });
const db = drizzle(neon(env.postgres.databaseUrl), { schema });

// Sync — reads already-injected process.env and validates it (no network).
// Use in app bootstrap where async isn't available.
const env2 = parseEnv(config, process.env.NEON_BRANCH_NAME ?? "main");
```

Both return the same namespaced `NeonEnv` shape: `postgres` is always present; `auth` and `dataApi` are included (and statically typed) when the evaluated branch policy enables them.

| Function | Description |
| --- | --- |
| `fetchEnv(config, { projectId, branchId, ... })` | Async. Calls the Neon API for the given project + branch and returns live connection strings (and Auth/Data API values when enabled). `projectId` and `branchId` are required (`branchId` is a `br-…` id). |
| `parseEnv(config, branchName)` | Sync. Reads/validates the Neon env vars already present in `process.env`, evaluating the policy for `branchName`. Throws `PlatformError(EnvNotInjected)` listing missing vars when the env isn't populated. |
| `toEntries(env)` | Project a resolved `NeonEnv` into `{ KEY: value }` pairs for cross-process transport (named after the web `.entries()` convention; returns a `Record`). |

## CLI

One command — inject the env vars for your `neon.ts` branch into a dev command:

```bash
neon-env run -- npm run dev
neon-env run -- pnpm dev
```

`run` loads `neon.ts`, resolves the branch (via `--branch`, `NEON_BRANCH_ID`, or `.neon[/project.json]`), fetches the connection strings from Neon, and spawns the command with `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (and `NEON_AUTH_BASE_URL` / `NEON_DATA_API_URL` when the policy enables them) injected on top of the inherited environment. Stdio is inherited so interactive dev servers keep working, and the parent exits with the child's exit code.

Flags: `--config <path>`, `--project-id`, `--branch`, `--api-key`, `--debug`.

## Env vars produced

| Key | From |
| --- | --- |
| `DATABASE_URL` | pooled connection string |
| `DATABASE_URL_UNPOOLED` | direct connection string |
| `NEON_AUTH_BASE_URL` | Neon Auth integration (when `auth` is enabled) |
| `NEON_DATA_API_URL` | Data API integration (when `dataApi` is enabled) |

## Resolution

The **CLI** (`neon-env run`) resolves project + branch itself: `--project-id` / `--branch` flag → `NEON_PROJECT_ID` / `NEON_BRANCH_ID` env → `.neon[/project.json]` walked up from the working directory. The API key resolves via `--api-key` → `NEON_API_KEY` → `~/.config/neonctl/credentials.json`.

The **library functions** do none of this — pass `projectId` / `branchId` explicitly. This keeps `.neon` parsing in one place (the CLI / neonctl) and the functions pure.
