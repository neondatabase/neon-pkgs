# @neondatabase/env

Resolve and inject Neon connection strings for the branch selected by your `neon.ts` policy. Exposes `fetchEnv` / `parseEnv` functions plus a single CLI command: `neon-env run -- <cmd>`.

Builds on [`@neondatabase/config`](../config) — it reuses the `Config` policy type and the Neon API client.

## Install

```bash
npm install @neondatabase/env
```

## Functions

```ts
import config from "../neon";
import { fetchEnv, parseEnv } from "@neondatabase/env/v1";

// Async — resolves the branch and calls the Neon API for live connection strings.
// Use in build scripts / top-level await.
const env = await fetchEnv(config);
const db = drizzle(neon(env.postgres.databaseUrl), { schema });

// Sync — reads already-injected process.env and validates it (no network).
// Use in app bootstrap where async isn't available.
const env2 = parseEnv(config);
```

Both return the same namespaced `NeonEnv` shape: `postgres` is always present; `auth` and `dataApi` are included (and statically typed) when the evaluated branch policy enables them.

| Function | Description |
| --- | --- |
| `fetchEnv(config, options?)` | Async. Resolves the project + branch, calls the Neon API, returns live connection strings (and Auth/Data API values when enabled). |
| `parseEnv(config)` | Sync. Reads/validates the Neon env vars already present in `process.env`. Throws `PlatformError(EnvNotInjected)` listing missing vars when the env isn't populated. |
| `neonEnvToProcessEnv(env)` | Project a resolved `NeonEnv` into `{ KEY: value }` pairs for cross-process transport. |

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

Project/branch/api-key resolve through the same chain as `@neondatabase/config` (option/arg → env var → `.neon[/project.json]` → neonctl credentials).
