# @neondatabase/env

## 0.11.5

### Patch Changes

- d031275: Auto-pick Neon's default `neondb` database when a branch has more than one. Previously `fetchEnv` threw as soon as a branch had multiple databases, so `neonctl link` / `neonctl env pull` failed on a branch that had `neondb` alongside another database. It now uses `neondb` when present (or the sole database otherwise); a branch with several databases and no `neondb` still throws so the choice is never made randomly — rename one to `neondb` or keep a single database (or pass `databaseName` when calling `fetchEnv` directly).

## 0.11.4

### Patch Changes

- @neon/config@0.9.5

## 0.11.3

### Patch Changes

- Updated dependencies [3abe4f7]
  - @neon/config@0.9.4

## 0.11.2

### Patch Changes

- 22d5cdd: Reference the `neon` CLI over `neonctl` in user-facing output and docs. The CLI
  ships both the `neon` and `neonctl` binaries; `neonctl` keeps working as an
  alias, but `neon init` now emits `neon …` commands, status messages, and
  agent-facing prompts using the cleaner `neon` name, and the package READMEs
  document `neon`. Internal package install/version checks and the
  `~/.config/neonctl/` config path are unchanged.
- Updated dependencies [22d5cdd]
  - @neon/config@0.9.3

## 0.11.1

### Patch Changes

- @neon/config@0.9.2

## 0.11.0

### Minor Changes

- 3ad35b3: AI Gateway env is now exposed only under its Neon-branded vars. `preview.aiGateway` no longer emits the OpenAI SDK aliases `OPENAI_API_KEY` / `OPENAI_BASE_URL` — matching the deployed Functions runtime, which only injects `NEON_AI_GATEWAY_TOKEN` / `NEON_AI_GATEWAY_BASE_URL`.

  - `fetchEnv` / `parseEnv` / `toEntries` now read and write `NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL`. `env.aiGateway.apiKey` maps to the token and `env.aiGateway.baseUrl` is now the **bare** gateway host (`https://<branch>-api.ai.<region>.…`, no `/ai-gateway/openai/v1` path) — clients like `@neon/ai-sdk-provider` append the dialect routes themselves.
  - `neonctl env pull` no longer writes `OPENAI_*`, and now owns/prunes the `NEON_AI_GATEWAY_*` vars.

  Migration: if you relied on the injected `OPENAI_API_KEY` / `OPENAI_BASE_URL`, read `NEON_AI_GATEWAY_TOKEN` / `NEON_AI_GATEWAY_BASE_URL` instead (or set your own `OPENAI_*` by hand — `env pull` leaves user-set vars untouched).

## 0.10.1

### Patch Changes

- @neon/config@0.9.1

## 0.10.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

### Patch Changes

- Updated dependencies
  - @neon/config@0.9.0

## 0.9.0

### Minor Changes

- b78ced2: Resolve branches by name or id, not id only. `fetchEnv` now accepts a `branch` option holding either a branch name (e.g. `main`) or an id (`br-…`); the legacy id-only `branchId` option still works. The `neon-env` CLI reads the `branch` field from the flat `.neon` file written by `neonctl link` (falling back to legacy `branchId`), and honors `NEON_BRANCH` in addition to `NEON_BRANCH_ID`. This fixes `neon-env run`/`export` failing to resolve a branch pinned by name.

## 0.8.1

### Patch Changes

- Updated dependencies [1f77d97]
  - @neondatabase/config@0.8.1

## 0.8.0

### Minor Changes

- Drop the `/v1` subpath export — import everything from the package root instead.

  `@neondatabase/env/v1`, `@neondatabase/functions/v1`, and `@neondatabase/ai-sdk-provider/v1` are no longer published. Use the package root (`@neondatabase/env`, `@neondatabase/functions`, `@neondatabase/ai-sdk-provider`), which already exposed the full surface. Versioned subpath exports remain only on `@neondatabase/config` and `@neondatabase/config-runtime`, where pinning a policy-schema major is meaningful.

## 0.7.0

### Minor Changes

- fe5d092: Remove the `NEON_STORAGE_FORCE_PATH_STYLE` env var and the `storage.forcePathStyle` field from `NeonStorageEnv`.

  It was always `true` and has no AWS-standard env name, so the S3 SDKs never read it automatically — you already had to wire `forcePathStyle` into your `S3Client` by hand. Neon's storage gateway always requires path-style addressing, so set `forcePathStyle: true` directly on your client. `env pull` no longer writes the variable, and `parseEnv` / `toEntries` no longer read or emit it. The raw `NeonBranchStorageSnapshot.forcePathStyle` from `@neondatabase/config` (the `GET .../storage` response) is unchanged.

- 75abe16: Remove the `NEON_STORAGE_REGION` env var (the Neon-branded alias of `AWS_REGION`).

  The region is already injected under the SDK-standard `AWS_REGION`, which the AWS S3 SDKs read automatically — the duplicate `NEON_STORAGE_REGION` alias was never read back by `parseEnv` and bought nothing. `env pull` no longer writes it and `toEntries` no longer emits it. `NeonStorageEnv.region` (mapped to `AWS_REGION`) is unchanged.

## 0.6.0

### Minor Changes

- 0cabe8e: Add branch-scoped service credentials + object-storage / AI Gateway env (Preview).

  - `@neondatabase/config`: the `NeonApi` adapter gains `createCredential` / `listCredentials` / `revokeCredential` (the beta `…/credentials` endpoints) and `getProjectBranchStorage` (the beta `…/storage` endpoint → `s3_endpoint` / `region` / `force_path_style`), plus the `CredentialScope` / `CredentialPrincipalType` types, the `NeonCredentialSecret` / `NeonCredentialMeta` / `CreateCredentialInput` / `NeonBranchStorageSnapshot` shapes, and pure `deriveCredentialScopes` / `credentialScopesSatisfied` helpers.
  - `@neondatabase/env`: `fetchEnv` / `parseEnv` expose two new namespaces, mapped onto the **SDK-standard** env names so the AWS and OpenAI SDKs work from env alone:
    - `env.storage` (when `preview.buckets`) → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` (and `NEON_STORAGE_REGION`), `NEON_STORAGE_FORCE_PATH_STYLE`.
    - `env.aiGateway` (when `preview.aiGateway`) → `OPENAI_API_KEY`, `OPENAI_BASE_URL` (the branch gateway host + `/ai-gateway/openai/v1`).
    - The access keys come from a minted branch credential; the S3 endpoint/region/path-style come from `getProjectBranchStorage`. `functions:invoke` rides along on the credential's scopes when functions are also declared, but functions never mint a credential on their own. `fetchEnv` reuses the secrets already present in its env source (round-tripping the one-time `api_token` / `s3_secret_access_key`) and only re-mints when a needed secret is missing. Policies without `preview.buckets` / `preview.aiGateway` never touch the credentials/storage endpoints, so the Postgres / Auth / Data API path is unchanged.
  - `@neondatabase/config-runtime`: `pullConfig` / `inspect` report secret-free issued-credential metadata under `preview.credentials` (degrading to none when the endpoint is unavailable).

- 71adaba: Inject `NEON_BRANCH` (the branch name) alongside the other Neon env vars.

  The Neon Functions runtime injects `NEON_BRANCH` into every branch (including the default)
  by default, so `fetchEnv` now surfaces the branch on a new optional `branch` namespace and
  `toEntries` emits `NEON_BRANCH`. That means `neon dev` / `neon-env run` / `neon env pull`
  write `NEON_BRANCH` into local dev too, mirroring the deployed runtime. `parseEnv` reads it
  back when present (optional — a missing `NEON_BRANCH` is not an error, so existing
  deployments and platform integrations keep working). The value is the branch **name** for now.

- c6a00b7: Add an optional key filter to `parseEnv` for requiring + returning only a subset of env vars.

  `parseEnv(config, keys)` now accepts an array of OS-level env-var keys (e.g.
  `["DATABASE_URL", "NEON_AUTH_BASE_URL"]`) as an alternative to the function-slug scope. In
  this mode only the selected vars are enforced and returned, projected into a **narrowed**
  `NeonEnv` shape — so a Next.js app that reads `DATABASE_URL` but not `DATABASE_URL_UNPOOLED`
  no longer throws over vars it never uses. The keys are typesafe against the policy
  (`SelectableEnvKey<Config>`): selecting a var from a namespace the policy doesn't enable is a
  compile error, and the result type drops both unselected namespaces and unselected properties
  within a kept namespace.

- 3fbf556: Remove the function `memoryMib` setting entirely.

  **Breaking.** Function memory is no longer user-configurable from `neon.ts` or the deploy
  API surface — it is fixed by the platform policy.

  - `@neondatabase/config`: drop `FunctionMemoryMib`, remove `memoryMib` from `FunctionTuning`,
    `ResolvedFunctionConfig`, and `DeployFunctionInput`. The real NeonApi adapter no longer
    sends a `memory_mib` form field.
  - `@neondatabase/config-runtime`: stop threading `memoryMib` through plan/apply steps.
  - A `neon.ts` that sets `branch.preview.functions[slug].memoryMib` is now a type error and
    is rejected by the schema.

- 0d4c973: Reshape `defineConfig` into a static existential set + a tuning-only `branch` closure.

  **Breaking.** `defineConfig` now takes an **object**, not a function:

  ```ts
  export default defineConfig({
    auth: true,
    dataApi: false,
    preview: {
      aiGateway: false,
      functions: {
        hello: {
          name: "Hello",
          source: "./functions/hello.ts",
          dev: { port: 8787 },
        },
      },
      buckets: { uploads: { access: "public_read" } },
    },
    branch: (branch) => ({
      protected: branch.name === "main",
      preview: { functions: { hello: { memoryMib: 1024 } } },
    }),
  });
  ```

  - GA service toggles (`auth`, `dataApi`) and the beta `preview` block (`aiGateway`,
    `functions`, `buckets`) are **static and top-level**, so the secret set is known at the
    type level. `functions`/`buckets` are **records keyed by slug/name** (regex-enforced,
    dup-free).
  - The `branch` closure is **tuning-only** (`parent`/`ttl`/`protected`/`postgres` + per-function
    `memoryMib`/`runtime`), and is type-constrained to only reference declared function slugs.
    It cannot add or remove services or functions.
  - `resolveConfig` still returns the same `ResolvedBranchConfig`, so `diff`/`plan`/`apply`
    are unchanged at runtime. `pullConfig` now returns the new `Config` shape.
  - `@neondatabase/env`: `NeonEnv<C>` is derived directly from the static toggles, so it is
    exact. `parseEnv` drops the `branchName` argument and takes an optional **scope** — omit
    for external env, or pass a function slug to also get a typed `function` namespace of that
    function's declared env keys.

### Patch Changes

- b6efa3a: Fix the AI Gateway env URL and add `NEON_AI_GATEWAY_*` vars.

  `fetchEnv` / `env pull` built `OPENAI_BASE_URL` from the **control-plane API origin** (`<NEON_API_HOST>/ai-gateway/openai/v1`), which doesn't serve the gateway (returns 403/CSRF from the console). The AI Gateway is a **branch-scoped host** (`<branchId>-api.ai.<region>.…`).

  - `OPENAI_BASE_URL` is now derived from the branch's Postgres connection host (`<branchId>-api.ai.[c-N.]<region>.<cloud>.neon.<tld>/ai-gateway/openai/v1`), keeping any infra cell prefix.
  - `env pull` additionally emits the Neon-branded aliases alongside the OpenAI ones:
    - `NEON_AI_GATEWAY_TOKEN` — the credential bearer (same value as `OPENAI_API_KEY`).
    - `NEON_AI_GATEWAY_BASE_URL` — the bare branch gateway host (`scheme://host`, no path), as consumed by the `@ai-sdk/neon` provider, which appends the `/ai-gateway/<dialect>/…` routes itself (https://github.com/vercel/ai/pull/15997).

- Preserve the infra cell prefix (`c-N.`) when deriving the AI Gateway host.

  `fetchEnv` / `env pull` build the branch gateway host (`OPENAI_BASE_URL` and the bare-host alias `NEON_AI_GATEWAY_BASE_URL`) from the branch's Postgres connection host. It dropped the `c-N.` cell segment, producing `https://<branch-id>-api.ai.<region>.<cloud>.neon.<tld>`. The gateway is cell-routed, so the correct host keeps the cell — matching the Console value:

  ```
  # before (wrong host — missing cell)
  NEON_AI_GATEWAY_BASE_URL=https://br-…-api.ai.us-east-2.aws.neon.tech

  # after (matches Console)
  NEON_AI_GATEWAY_BASE_URL=https://br-…-api.ai.c-3.us-east-2.aws.neon.tech
  ```

  The host suffix is now taken verbatim after the endpoint label, keeping any `c-N.` prefix intact.

- 1fc049d: Surface the Neon Auth JWKS URL as `NEON_AUTH_JWKS_URL`.

  When a branch policy enables `auth`, `fetchEnv` / `parseEnv` / `toEntries` now expose
  `env.auth.jwksUrl` (`NEON_AUTH_JWKS_URL`) alongside the existing `env.auth.baseUrl`, so
  apps and agents get the JWKS endpoint needed to verify Neon Auth tokens — not just the base
  URL. `fetchEnv` reads it from the live integration's `jwks_url`; `parseEnv` reads and
  validates it from `process.env`.

- 11c14e6: Default `fetchEnv` to the `neondb_owner` role when a branch has several roles.

  Enabling Neon Auth / the Data API provisions the PostgREST roles
  (`authenticator`, `anonymous`, `authenticated`) alongside the project owner, so `env pull`
  saw multiple roles and refused to auto-pick the connection role. `fetchEnv` now defaults to
  Neon's owner role (`neondb_owner`) — or, for projects created with a custom owner name, the
  single role left after dropping those managed Auth/Data API roles — and only asks for an
  explicit `roleName` when more than one app role genuinely remains.

- c57536b: Honor `NEON_API_HOST` / the new `apiHost` option when building the default Neon API client. `createNeonApiFromOptions` now resolves the host (explicit `apiHost` option → `NEON_API_HOST` env → production default), and `pullConfig`, `pushConfig`, `inspect`/`plan`/`apply`, and `fetchEnv` accept and forward an optional `apiHost`.
- ae9a478: Fix object-storage credentials: map `AWS_ACCESS_KEY_ID` to the credential's full token id.

  `fetchEnv` / `parseEnv` previously injected the credential's short token id (`token_id_short`, e.g. `805e248a8e54`) as `AWS_ACCESS_KEY_ID`. The storage gateway only accepts the full token id (`token_id`, e.g. `nak_live_805e248a8e54…`), so every S3 request failed with `InvalidAccessKeyId`. `env.storage.accessKeyId` (and `AWS_ACCESS_KEY_ID`) now carries the full token id, making the standard object-storage path usable.

- Updated dependencies [101c4cb]
- Updated dependencies [0cabe8e]
- Updated dependencies [b6efa3a]
- Updated dependencies [9170128]
- Updated dependencies [4702726]
- Updated dependencies [11c14e6]
- Updated dependencies [b6efa3a]
- Updated dependencies [c57536b]
- Updated dependencies [5c7c006]
- Updated dependencies [101c4cb]
- Updated dependencies [b6efa3a]
- Updated dependencies [3fbf556]
- Updated dependencies [0d4c973]
  - @neondatabase/config@0.8.0

## 0.1.2

### Patch Changes

- Updated dependencies
  - @neondatabase/config@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [ff7103b]
  - @neondatabase/config@0.2.0

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

### Patch Changes

- Updated dependencies [81cfe0a]
  - @neondatabase/config@0.1.0
