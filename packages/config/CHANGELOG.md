# @neondatabase/config

## 0.2.1

### Patch Changes

- Decouple `dev.portless` from `dev.port` on `FunctionConfig`. `portless` and `port` are now independent optional fields rather than a discriminated union requiring `port` when `portless` is true. Portless assigns the local port itself (it injects `PORT`), so a `portless` function does not — and should not — specify one. `port` still binds exactly when set (and `neon dev` fails if it is taken) or selects a free port when omitted, for non-portless functions.
- Tighten the function slug rule to match the Neon Functions API: `^[a-z0-9]{1,20}$` (1–20 lowercase letters and digits, no hyphens). Previously the schema accepted hyphenated DNS-label slugs up to 40 chars.
- Surface a clear error when a Preview feature isn't available for the project/region, instead of a cryptic crash or a misleading plan. Reading a non-JSON response body (e.g. a 404 `"this route does not exist"`) no longer throws `Unexpected token … is not valid JSON` — it's wrapped so the real HTTP status surfaces. And `listBranchBuckets` / `listBranchFunctions` / `getAiGatewayEnabled` now throw a `PLATFORM_FEATURE_UNAVAILABLE` error ("… is a Preview feature that is not available for this project or region … Enable it first") when the endpoint reports unavailable (404 route missing, or a 503/4xx "not available"). So `inspect` / `status` / `plan` / `apply` (and `neon dev`) fail with an actionable message rather than, e.g., planning to create resources the API will refuse to create.

## 0.2.0

### Minor Changes

- ff7103b: Add an optional `dev` block to `FunctionConfig` for local development with `neon dev`: `dev?: { port?: number; portless?: boolean }`. It is typed as a discriminated union so `portless: true` requires a concrete `port` (validated at both the type level and by the zod schema). `dev` is passed through untouched onto `ResolvedFunctionConfig` (no defaults applied) and is ignored at deploy time — only `neon dev` reads it (to serve every function declared in `neon.ts` on its configured port, optionally via `portless`).

## 0.1.0

### Minor Changes

- 81cfe0a: Initial release of the Config-as-Code packages for the Neon Platform.

  **`@neondatabase/config`** — the authoring surface you import from `neon.ts`. Define your Neon project, branches, TTLs, compute settings, and Preview features in a single typed policy. Intentionally free of heavy/native dependencies so importing it stays cheap and bundler-safe.

  - `defineConfig(input)` — strict, zod-backed config validation that aggregates every issue into a single error.
  - `diffConfig(...)` — the pure diff engine (desired policy vs. live state → plan steps).
  - `createRealNeonApi` + the `NeonApi` interface, the config loader, and a fully typed, actionable error surface (every error carries a stable `code` and structured `details`).
  - A `preview` block for upcoming Neon Platform features (all backed by `x-stability-level: beta` endpoints):
    - **`preview.functions`** — deploy worker/Vercel-style handlers (`export default { fetch }` or `export async function handler(req)`) from a `source` file path. Supports per-function `env` (validated as defined strings), `runtime` (`nodejs24`), and `memoryMib`, with sane defaults.
    - **`preview.buckets`** — branchable object-storage buckets, each `{ name, access?: "private" | "public_read" }` (defaults to `private`).
    - **`preview.aiGateway`** — an `{ enabled }` toggle, mirroring the `auth` / `dataApi` semantics.

  ```ts
  import { defineConfig } from "@neondatabase/config/v1";

  export default defineConfig((branch) => ({
    preview: {
      functions: [
        {
          name: "Hello World",
          slug: "hello-world",
          source: "./functions/hello-world.ts",
          env: { RESEND_API_KEY: process.env.RESEND_API_KEY },
        },
      ],
      buckets: [{ name: "uploads", access: "public_read" }],
      aiGateway: { enabled: true },
    },
  }));
  ```

  **`@neondatabase/config-runtime`** — the imperative runtime. Reads a branch's live state, diffs a policy against it, applies changes, and bundles + deploys Neon Functions. Function bundling pulls in `esbuild`, so this is the package CLIs and CI import — keeping `esbuild` out of the dependency tree of anyone who only imports `defineConfig` from `neon.ts`.

  - `inspect` / `plan` / `apply` (Terraform-style), plus the lower-level `pushConfig` / `pullConfig` engine.
  - Preview features are applied **additively** (buckets and functions are created and the AI Gateway is enabled; nothing is auto-deleted), and `inspect` / `pullConfig` reports a branch's live Preview state.
  - `buildFunctionBundle` — bundles a function's `source` with esbuild and zips it for deploy.

  **`@neondatabase/env`** — resolves and injects Neon connection strings for the branch selected by your `neon.ts` policy.

  - `fetchEnv` / `parseEnv` — return a fixed, statically-typed, namespaced env shape (e.g. `env.postgres.databaseUrl`).
  - A single `neon-env run -- <cmd>` CLI to run any command with the resolved Neon connection strings injected into its environment.
