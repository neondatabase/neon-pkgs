---
"@neondatabase/platform": minor
---

Split env loading into two paths so both async (build scripts) and sync (framework configs that disallow top-level await) callers get the same statically-typed `NeonEnv` shape. Add CLI commands for injecting the env into other tooling so `.env` files are optional.

**SDK:**

- **Rename `loadEnv` → `fetchEnv`** (async, hits the Neon API). Same options, same `NeonEnv` return.
- **New `parseEnv(config, options?)`** — synchronous, zero I/O. Reads `process.env` (or `options.env`), validates the required Neon vars with zod, and returns the same `NeonEnv`. Throws `PLATFORM_ENV_NOT_INJECTED` listing every missing/invalid var when the env isn't fully populated.
- New `NEON_ENV_VAR_KEYS` constant exposes the OS-level env-var keys (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`) so callers building their own pull/inject tooling can stay in sync with the SDK.
- New `ErrorCode.EnvNotInjected` (`PLATFORM_ENV_NOT_INJECTED`).

**CLI:**

- **`neon-ts env pull [file]`** — fetches the live connection strings and writes them to a `.env`-format file. Defaults to `.env.local` (matches Next.js / Vite / Drizzle Kit auto-load conventions). Supports `--branch`, `--project-id`, `--org-id`, `--api-key`, `--config`. Mirrors `vercel env pull`'s ergonomics.
- **`neon-ts env run -- <cmd...>`** — spawns a command with `DATABASE_URL` / `DATABASE_URL_UNPOOLED` injected on top of the inherited `process.env`. Stdio inherited so dev servers stay interactive; parent exits with the child's exit code. Same flags as `env pull`.

```ts
// drizzle.config.ts — no async allowed
import { defineConfig } from "drizzle-kit";
import { parseEnv } from "@neondatabase/platform/v1";
import config from "./neon";

export default defineConfig({
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
