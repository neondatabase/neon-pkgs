# @neondatabase/config

## 0.10.1

### Patch Changes

- Updated dependencies [630f102]
  - @neon/sdk@1.4.0

## 0.10.0

### Minor Changes

- 57461c9: Apply a `neon.ts` policy as part of creating a branch, so a rejected setting can't leave a half-configured branch behind — and keep pulled dotenv files out of git.

  `createBranch` used to create the branch and then push the policy onto it, so a setting Neon rejected (a plan-gated compute value, an out-of-range autoscaling limit) failed _after_ the branch existed: the branch stayed behind, `.neon` was never pinned, no env was pulled, and re-running `neon checkout` silently accepted the half-configured branch because checkout never reconciles a branch that already exists. Everything the policy can express in the create call — `parent`, `ttl`, `protected`, and compute settings — now rides along on it, and Neon validates the request as a whole, so a rejected value fails with no branch created and the API's own error. `result.applied` still reports those settings, described exactly like the changes a push applies, so folding them into the creation doesn't make them disappear from the summary (`neon checkout` prints them as a `parent → main` / `ttl → …` / `computeSettings.autoscalingLimitMaxCu → 2` diff).

  Services — Neon Auth, the Data API, buckets, and functions — are provisioned against an existing branch id and have no create-time equivalent, so that window stays open. It is now typed: `createBranch` throws `PartialBranchCreateError` (exported from `@neon/config` with `branchId` / `branchName` / `reason`, plus an `isPartialBranchCreateError` guard), and `neon checkout` uses it to pin the branch and pull its env before failing with the cause and both recovery paths (`neon deploy --update-existing`, or delete and check out again for a policy keyed on `!branch.exists`).

  `neon env pull` — including the pull bundled into `link` / `checkout` / `deploy` — now adds a dotenv file it creates to `.gitignore`, the same way the `.neon` context file is handled, so a live `DATABASE_URL` isn't one `git add -A` from being committed. Nothing is appended when an existing pattern such as `.env*` or `*.local` already covers the file, and a dotenv file that already existed is left alone.

## 0.9.6

### Patch Changes

- Updated dependencies
  - @neon/sdk@1.3.0

## 0.9.5

### Patch Changes

- Updated dependencies [a8e4937]
  - @neon/sdk@1.2.0

## 0.9.4

### Patch Changes

- 3abe4f7: Update platform-feature-unavailable errors for the beta rollout: drop outdated
  "private preview" / "Preview feature" wording, say features are currently in
  beta and only in `aws-us-east-2` (more regions coming shortly), and treat API
  bodies that say a feature is unavailable for the project/region as a region gate
  (not a transient incident) even when the status is 503. `neon-init`
  getting-started prompts use the same wording.

## 0.9.3

### Patch Changes

- 22d5cdd: Reference the `neon` CLI over `neonctl` in user-facing output and docs. The CLI
  ships both the `neon` and `neonctl` binaries; `neonctl` keeps working as an
  alias, but `neon init` now emits `neon …` commands, status messages, and
  agent-facing prompts using the cleaner `neon` name, and the package READMEs
  document `neon`. Internal package install/version checks and the
  `~/.config/neonctl/` config path are unchanged.
- Updated dependencies [22d5cdd]
  - @neon/sdk@1.1.1

## 0.9.2

### Patch Changes

- Updated dependencies [dba7d3f]
  - @neon/sdk@1.1.0

## 0.9.1

### Patch Changes

- Updated dependencies [9b2794e]
- Updated dependencies [d511ca4]
  - @neon/sdk@1.0.0

## 0.9.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

### Patch Changes

- Updated dependencies
  - @neon/sdk@0.2.0

## 0.8.1

### Patch Changes

- 1f77d97: Migrate the real Neon API adapter (`createRealNeonApi`) from the deprecated `@neondatabase/api-client` (axios) to the new fetch-based `@neon/sdk` raw layer. The `NeonApi` façade and all behavior are unchanged — the standard project/branch/endpoint/role/database/data-api calls now go through `@neon/sdk/raw`, and a small `unwrap` helper re-throws non-2xx responses in the same shape the existing error wrapper and 423 retry already consume. This drops `@neondatabase/api-client` from the package's runtime dependencies in favor of the zero-dependency `@neon/sdk`.

## 0.8.0

### Minor Changes

- 101c4cb: Stop treating the AI Gateway as a provisionable branch resource. The AI Gateway is always available on a branch — it is credential-gated, not per-branch provisioned, and has no control-plane enable/disable/status route. Declaring `preview.aiGateway` in a `neon.ts` only means "mint a branch credential scoped `ai_gateway:invoke` and surface the gateway env vars (`OPENAI_*` / `NEON_AI_GATEWAY_*`)", which `@neondatabase/env` already does without touching any AI Gateway endpoint.

  Previously `plan` / `apply` / `status` (and the policy-gated `env pull`) probed `GET /projects/{p}/branches/{b}/ai-gateway` to diff an `enable-ai-gateway` step. That endpoint isn't part of the platform, so the probe failed with a `PLATFORM_FEATURE_UNAVAILABLE` error and broke commands that otherwise only needed `DATABASE_URL` / auth. Removed end to end:

  - **`@neondatabase/config`** — `NeonApi` no longer declares `getAiGatewayEnabled` / `enableAiGateway` / `disableAiGateway`; the `enable-ai-gateway` `PlanStep` and `RemotePreviewState.aiGatewayEnabled` are gone, and `diffConfig` never emits an AI Gateway step. `ResolvedPreviewConfig.aiGatewayEnabled` stays — it still drives the credential scope and env vars.
  - **`@neondatabase/config-runtime`** — `pushConfig` no longer probes or applies AI Gateway state, and `PulledPreview.aiGatewayEnabled` is removed from `pullConfig` / `inspect` (the gateway is not per-branch state to report).

  Consumers reading `PulledPreview.aiGatewayEnabled` (e.g. a CLI `config status` view) should drop it; `preview.aiGateway` continues to work in `neon.ts` exactly as before for env resolution.

- 0cabe8e: Add branch-scoped service credentials + object-storage / AI Gateway env (Preview).

  - `@neondatabase/config`: the `NeonApi` adapter gains `createCredential` / `listCredentials` / `revokeCredential` (the beta `…/credentials` endpoints) and `getProjectBranchStorage` (the beta `…/storage` endpoint → `s3_endpoint` / `region` / `force_path_style`), plus the `CredentialScope` / `CredentialPrincipalType` types, the `NeonCredentialSecret` / `NeonCredentialMeta` / `CreateCredentialInput` / `NeonBranchStorageSnapshot` shapes, and pure `deriveCredentialScopes` / `credentialScopesSatisfied` helpers.
  - `@neondatabase/env`: `fetchEnv` / `parseEnv` expose two new namespaces, mapped onto the **SDK-standard** env names so the AWS and OpenAI SDKs work from env alone:
    - `env.storage` (when `preview.buckets`) → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` (and `NEON_STORAGE_REGION`), `NEON_STORAGE_FORCE_PATH_STYLE`.
    - `env.aiGateway` (when `preview.aiGateway`) → `OPENAI_API_KEY`, `OPENAI_BASE_URL` (the branch gateway host + `/ai-gateway/openai/v1`).
    - The access keys come from a minted branch credential; the S3 endpoint/region/path-style come from `getProjectBranchStorage`. `functions:invoke` rides along on the credential's scopes when functions are also declared, but functions never mint a credential on their own. `fetchEnv` reuses the secrets already present in its env source (round-tripping the one-time `api_token` / `s3_secret_access_key`) and only re-mints when a needed secret is missing. Policies without `preview.buckets` / `preview.aiGateway` never touch the credentials/storage endpoints, so the Postgres / Auth / Data API path is unchanged.
  - `@neondatabase/config-runtime`: `pullConfig` / `inspect` report secret-free issued-credential metadata under `preview.credentials` (degrading to none when the endpoint is unavailable).

- b6efa3a: Give `neon.ts` config errors a precise, actionable message instead of a misleading catch-all.

  A bad function slug used to surface as `preview.functions.<slug>: Invalid key in record`, wrapped in a generic `Failed to evaluate … This is usually a TypeScript syntax error` hint — pointing users at a syntax bug that wasn't there. Two fixes:

  - `defineConfig` validation now hoists the real reason out of zod's `invalid_key` issue, so a rejected record key reports _why_ (e.g. `preview.functions.hello-world: function slug must be 1-20 lowercase letters and digits (no hyphens or other characters)`).
  - `loadConfigFromFile` surfaces a `PlatformError` thrown during evaluation verbatim (the config is invalid, not the TypeScript), reserving the "run it with tsx" hint for genuine syntax/runtime/missing-dependency failures.
  - An `undefined` function `env` value (typically a `process.env.X` referenced in `neon.ts` that is unset) used to surface as zod's opaque `preview.functions.hello.env.test: Invalid input: expected string, received undefined`. It now names the function and env key and points at the fix, e.g. `Environment variable "test" for function "hello" is undefined — its value (typically a process.env.*) is unset. Set it (e.g. add it to your .env) or provide a fallback like process.env.X ?? "".` (a non-`undefined` wrong type keeps zod's default message).

  Adds `isPlatformError`, a structural guard that recognises a `PlatformError` even across the jiti module-realm boundary (where `instanceof` fails), re-exported from `@neondatabase/config-runtime`.

- 9170128: Add a rich `dataApi` config to `neon.ts`: auth provider selection + reconcilable runtime settings.

  `dataApi` still accepts the boolean/toggle forms (`true` / `{}` / `{ enabled: true }`), but now also takes an object describing the integration:

  ```ts
  defineConfig({
    auth: true,
    dataApi: {
      authProvider: "neon", // default; "external" verifies a third-party IdP
      settings: { dbSchemas: ["public", "api"], dbMaxRows: 1000 },
    },
  });
  ```

  - **`authProvider`** is `"neon"` (default) or `"external"` (friendly values, mapped to the API's `neon_auth` / `external`). The external-IdP wiring (`jwksUrl`, `providerName`, `jwtAudience`) is only valid — and only typeable — on the `"external"` variant (the `"neon"` variant types those fields as `never`).
  - **`settings`** mirror the Neon API `DataAPISettings` in camelCase (`dbAggregatesEnabled`, `dbAnonRole`, `dbExtraSearchPath`, `dbMaxRows`, `dbSchemas`, `jwtRoleClaimKey`, `jwtCacheMaxLifetime`, `openapiMode`, `serverCorsAllowedOrigins`, `serverTimingEnabled`).
  - **A `"neon"` Data API requires Neon Auth.** Enforced both at author time and at runtime (zod cross-field check). When `dataApi` is enabled with Neon Auth but top-level `auth` is missing, the `dataApi` field's expected type carries a readable hint (`… requires `auth: true`, or use `dataApi: { authProvider: 'external', jwksUrl: ... }``) so the error points straight at the fix instead of an opaque `Type '…' is not assignable to type 'never'`. An `"external"` Data API does not require auth.
  - The auth wiring is set when the Data API is first **enabled** (carried on the create request) and is immutable afterward. Changing the runtime `settings` is reconciled as an **update** and requires `updateExisting` / `--update-existing`, like compute/TTL/`protected` drift.

  The `add_default_grants` / `skip_auth_schema` create-only flags are intentionally not exposed.

- 11c14e6: `DurationString` for `computeSettings.suspendTimeout` and branch `ttl`: per-field autocomplete (within API limits) + a required unit.

  Both fields previously typed the duration as a bare `string`, which collapsed literal hints
  (no editor suggestions) and let a bare numeric string like `"7"` silently mean _7 seconds_.
  Now:

  - **Per-field autocomplete that fits the Neon API.** `suspendTimeout` suggests values in the
    scale-to-zero band `"1m"`–`"7d"` (the API allows 60s–604800s). `ttl` suggests `"1h"`–`"30d"`
    (the API caps branch expiration at 30 days). Both remain open: any other
    `` `${integer}${unit}` `` string or a `number` of seconds still type-checks.
  - **A unit is now required.** `"7"` is rejected at the type level and at runtime
    (`parseDuration`) — pass a `number` (`7`) for raw seconds, or add a unit (`"7d"`).
  - **Branch TTL is range-checked.** A new `parseBranchTtl` rejects TTLs over 30 days with a
    clear error instead of deferring to an API failure.

  **Breaking:** a bare numeric **string** (e.g. `"3600"`) is no longer accepted for `ttl` /
  `suspendTimeout` (use the `number` form or add a unit), and a `ttl` over 30 days is rejected.
  Richer typedoc with units (`s`/`m`/`h`/`d`/`w`), ranges, and scale-to-zero / branch-expiry
  examples; `DurationString`, `DurationUnit`, and `ComputeUnit` are exported from
  `@neondatabase/config/v1`.

- b6efa3a: Fix `config apply` failing with HTTP 405 when creating a function.

  The Neon API has no standalone "create function" endpoint: the functions collection (`POST /projects/{p}/branches/{b}/functions`) only supports `GET`, and a function is created implicitly by its first deployment (`POST .../functions/{slug}/deployments`). Pushing a policy with a new function therefore tried a non-existent create call and failed with `HTTP 405`.

  - `@neondatabase/config`: remove `createBranchFunction` from the `NeonApi` interface, the real adapter, and the fake. `deployBranchFunction` now creates the function on first deploy. The `deploy-function` plan step carries a `functionExists` flag (the separate `create-function` `PlanStep` is gone).
  - `@neondatabase/config-runtime`: `pushConfig` emits a single `deploy-function` step per function and reports it as a `create` (first deploy) or `update` (re-deploy) based on `functionExists`, instead of a separate create + deploy.

- b6efa3a: Remove the `dev.portless` option from a function's `dev` block. `neon dev` no longer wraps functions with the external `portless` proxy: that required a separately-installed global `portless` binary and only produced a clean `slug.localhost` URL behind a privileged (port 80/443) proxy — otherwise the URL still carried a proxy port (e.g. `:1355`), which defeats the purpose. The `dev` block now supports only `dev.port`; functions serve on a plain `http://localhost:<port>` (an explicit `dev.port`, or an auto-selected free port when omitted).
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

- 4702726: Fix `defineConfig` autocomplete for the nested `preview` (and `auth`/`dataApi`) fields.

  Each field was typed as the bare generic type parameter (e.g. `preview?: Preview`), so editors
  had no concrete shape to complete against in the object-literal position and showed
  `{} | undefined` with no hints for `aiGateway` / `functions` / `buckets`. The fields are now
  intersected with their concrete interfaces (`Preview & PreviewInput`, `Auth & ServiceToggleInput`,
  `DataApi & ServiceToggleInput`), restoring full member autocomplete and inline docs while keeping
  the `const` literal inference that types the `branch` closure's function slugs. Type-only change —
  no runtime behavior change.

- c57536b: Honor `NEON_API_HOST` / the new `apiHost` option when building the default Neon API client. `createNeonApiFromOptions` now resolves the host (explicit `apiHost` option → `NEON_API_HOST` env → production default), and `pullConfig`, `pushConfig`, `inspect`/`plan`/`apply`, and `fetchEnv` accept and forward an optional `apiHost`.
- 5c7c006: Fix `defineConfig` autocomplete **inside** the nested `preview.functions` / `preview.buckets` slug objects.

  The top-level `preview` fix (`Preview & PreviewInput`) restored hints for `aiGateway` / `functions` / `buckets`, but one level deeper editors still offered nothing inside a slug's value (e.g. `functions: { hello: { /* no name/source/env/dev hints */ } }`, and `buckets: { uploads: { /* no access hint */ } }`). `PreviewInput` types those records with a string index signature (`Record<string, FunctionDef>` / `Record<string, BucketDef>`), and once `defineConfig` infers `const Preview`, each authored slug becomes a _named_ property on the inferred literal — a named property shadows the index signature when the editor computes the contextual type of that slug's value, so the rest of `FunctionDef` / `BucketDef` never surfaced.

  `defineConfig` now also intersects `preview` with `PreviewAutocomplete<Preview>`, which re-declares each inferred slug's value as `FunctionDef` / `BucketDef` (a _named_ member, via a mapped type over the already-inferred keys). This puts those members back on the contextual type without going through the index signature, restoring full autocomplete and inline docs inside each function/bucket object. Type-only change — it does not widen what is accepted, change the inferred `const Preview`, or affect runtime behavior.

- 101c4cb: Make the "Preview feature unavailable" error status-aware and actionable instead of a misleading catch-all. When a `neon.ts` declares a Preview feature (Functions, object-storage buckets, branch credentials) that the project/region hasn't been granted, the reads behind `plan` / `apply` / `status` / `env pull` surfaced `"… is a Preview feature that is not available for this project or region … Enable it for your Neon account/project first"` — which read like the user had misconfigured something they could simply "enable".

  `previewUnavailableError` now:

  - Names the failing feature and summarizes the response in one short `HTTP <status> <reason>` line (e.g. `HTTP 404 Not Found`) — never a stack trace — and keeps the raw Neon API message + request id inline, which is valuable signal while these features are in preview.
  - Tailors the guidance to the HTTP status: a 404/501 points at region availability / private-preview access ("create a project in a region where the preview is enabled, and make sure your account has access"); a 503 distinguishes "still rolling out" from a transient incident and points at https://neonstatus.com / Neon support; everything else falls back to a generic account/region message.
  - Offers removing the feature from the `preview` block of your `neon.ts` as an escape hatch, and carries `status` / `requestId` on `error.details` for programmatic consumers.

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
