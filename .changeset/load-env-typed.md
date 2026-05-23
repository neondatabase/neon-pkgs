---
"@neondatabase/platform": minor
---

Split env loading into two paths so both async (build scripts) and sync (framework configs that disallow top-level await) callers get the same statically-typed `NeonEnv<Config>` shape, and make that shape **derived from `config.features`** so enabling Neon Auth or the Neon Data API adds those namespaces to the typed result automatically.

**SDK:**

- **Rename `loadEnv` → `fetchEnv`** (async, hits the Neon API). Same options, generic over `<const C extends Config>`.
- **New `parseEnv(config, options?)`** — synchronous, zero I/O. Reads `process.env`, validates the required Neon vars with zod, returns the same `NeonEnv<C>`. Throws `PLATFORM_ENV_NOT_INJECTED` listing every missing/invalid var.
- **New `features` block on `Config`**:
  ```ts
  defineConfig({
    project: {...}, branches: {...},
    features: { auth: true, dataApi: true },
  });
  ```
  - `features.auth: true` adds `env.auth = { projectId, publishableClientKey, secretServerKey, jwksUrl }` to the typed return — and `fetchEnv` will hit `GET /projects/:pid/branches/:bid/auth` to fetch the public bits, reading the two secrets from `process.env`.
  - `features.dataApi: true` adds `env.dataApi = { url }` and fetches it via the Data API endpoint.
  - When a feature is unset / `false`, its namespace is absent from both the static type and the runtime validation — accidental `env.auth` reads become type errors.
- New `NEON_ENV_VAR_KEYS` constant exposes the OS-level env-var keys (`DATABASE_URL`, `NEON_AUTH_PROJECT_ID`, …) for callers building their own pull/inject tooling.
- New `ErrorCode.EnvNotInjected` (`PLATFORM_ENV_NOT_INJECTED`).
- New `NeonApi` methods: `getNeonAuth(projectId, branchId)` and `getNeonDataApi(projectId, branchId, databaseName)`. Both return `null` when no integration exists on the branch (404 normalised).

**CLI:**

- **`neon-ts env pull [file]`** — fetches the live connection strings (and Auth / Data API vars when enabled) and writes them to a `.env`-format file. Defaults to `.env.local`. Supports `--branch`, `--project-id`, `--org-id`, `--api-key`, `--config`. Mirrors `vercel env pull`'s ergonomics.
- **`neon-ts env run -- <cmd...>`** — spawns a command with the env vars injected on top of the inherited `process.env`. Stdio inherited so dev servers stay interactive; parent exits with the child's exit code. Same flags as `env pull`.

```ts
// drizzle.config.ts — sync, no async allowed; statically typed against config.features
import { defineConfig as drizzleDefineConfig } from "drizzle-kit";
import { parseEnv } from "@neondatabase/platform/v1";
import config from "./neon";

export default drizzleDefineConfig({
  dialect: "postgresql",
  dbCredentials: { url: parseEnv(config).postgres.databaseUrlUnpooled },
});
```

```bash
# Pull once, then your framework loads .env.local automatically
neon-ts env pull

# Or wrap dev commands so the env is freshly fetched every run
neon-ts env run -- npm run dev
```
