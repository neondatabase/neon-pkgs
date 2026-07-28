# @neondatabase/config-runtime

## 0.10.1

### Patch Changes

- @neon/config@0.10.1

## 0.10.0

### Minor Changes

- 57461c9: Apply a `neon.ts` policy as part of creating a branch, so a rejected setting can't leave a half-configured branch behind — and keep pulled dotenv files out of git.

  `createBranch` used to create the branch and then push the policy onto it, so a setting Neon rejected (a plan-gated compute value, an out-of-range autoscaling limit) failed _after_ the branch existed: the branch stayed behind, `.neon` was never pinned, no env was pulled, and re-running `neon checkout` silently accepted the half-configured branch because checkout never reconciles a branch that already exists. Everything the policy can express in the create call — `parent`, `ttl`, `protected`, and compute settings — now rides along on it, and Neon validates the request as a whole, so a rejected value fails with no branch created and the API's own error. `result.applied` still reports those settings, described exactly like the changes a push applies, so folding them into the creation doesn't make them disappear from the summary (`neon checkout` prints them as a `parent → main` / `ttl → …` / `computeSettings.autoscalingLimitMaxCu → 2` diff).

  Services — Neon Auth, the Data API, buckets, and functions — are provisioned against an existing branch id and have no create-time equivalent, so that window stays open. It is now typed: `createBranch` throws `PartialBranchCreateError` (exported from `@neon/config` with `branchId` / `branchName` / `reason`, plus an `isPartialBranchCreateError` guard), and `neon checkout` uses it to pin the branch and pull its env before failing with the cause and both recovery paths (`neon deploy --update-existing`, or delete and check out again for a policy keyed on `!branch.exists`).

  `neon env pull` — including the pull bundled into `link` / `checkout` / `deploy` — now adds a dotenv file it creates to `.gitignore`, the same way the `.neon` context file is handled, so a live `DATABASE_URL` isn't one `git add -A` from being committed. Nothing is appended when an existing pattern such as `.env*` or `*.local` already covers the file, and a dotenv file that already existed is left alone.

### Patch Changes

- Updated dependencies [57461c9]
  - @neon/config@0.10.0

## 0.9.7

### Patch Changes

- @neon/config@0.9.6

## 0.9.6

### Patch Changes

- a89d6ca: Pull a branch's object-storage vars without a `neon.ts`. `pullConfig` now mirrors the branch's buckets into the resolvable config, so `neon dev` / `neon env pull` inject the S3-compatible `AWS_*` credentials for a branch that has a bucket even when there is no local `neon.ts` policy — matching how Neon Auth / the Data API already resolve from live branch state. Functions and the AI Gateway remain excluded (neither has branch-level state that can be faithfully read back).

## 0.9.5

### Patch Changes

- @neon/config@0.9.5

## 0.9.4

### Patch Changes

- Updated dependencies [3abe4f7]
  - @neon/config@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [22d5cdd]
  - @neon/config@0.9.3

## 0.9.2

### Patch Changes

- @neon/config@0.9.2

## 0.9.1

### Patch Changes

- @neon/config@0.9.1

## 0.9.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

### Patch Changes

- Updated dependencies
  - @neon/config@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [1f77d97]
  - @neondatabase/config@0.8.1

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

- 11c14e6: Add a `createBranch` operation that provisions a branch from a `neon.ts` policy.

  `apply` always evaluated the policy as an _existing_ branch (`exists: true`), so a policy that
  gates creation-time tuning on `!branch.exists` (TTL, compute settings, `parent`) never applied
  it when a branch was first created — e.g. `neonctl checkout <new-name>`, which created a bare
  branch and then `apply`'d it. New `createBranch(config, { projectId, branchName })`:

  1. evaluates the policy with `exists: false`,
  2. creates the branch from the policy's `parent` (falling back to the project default), and
  3. reconciles the rest (TTL, compute, `protected`, Neon Auth, Data API, functions) onto it.

  Also adds a `branchExists?: boolean` option to `pushConfig` (defaults to `true`) that controls
  the `branch.exists` value passed to the policy — the mechanism `createBranch` uses to apply as
  a new branch.

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

- b6efa3a: Fix `config apply` failing with HTTP 405 when creating a function.

  The Neon API has no standalone "create function" endpoint: the functions collection (`POST /projects/{p}/branches/{b}/functions`) only supports `GET`, and a function is created implicitly by its first deployment (`POST .../functions/{slug}/deployments`). Pushing a policy with a new function therefore tried a non-existent create call and failed with `HTTP 405`.

  - `@neondatabase/config`: remove `createBranchFunction` from the `NeonApi` interface, the real adapter, and the fake. `deployBranchFunction` now creates the function on first deploy. The `deploy-function` plan step carries a `functionExists` flag (the separate `create-function` `PlanStep` is gone).
  - `@neondatabase/config-runtime`: `pushConfig` emits a single `deploy-function` step per function and reports it as a `create` (first deploy) or `update` (re-deploy) based on `functionExists`, instead of a separate create + deploy.

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

- f7ddc9d: Bundle function dependencies into the deploy archive.

  The default function bundler (`buildFunctionBundle`) ran esbuild with `--packages=external`, so npm dependencies were left as bare imports and never shipped. Since the Functions runtime has no `node_modules`, any function importing a third-party package failed to load at runtime (`Cannot find package '…'`).

  It now bundles dependencies into `index.mjs` (Node built-ins stay external on `platform: "node"`) and prepends a `createRequire` banner so bundled CommonJS dependencies work inside the ESM output (avoids `Dynamic require of "fs" is not supported`).

- b6efa3a: Trim noise from `plan` / `apply` change details. The `auth` / `dataApi` / `aiGateway` toggles no longer carry a `details` blob (they're plain branch on/off switches — the auto-derived `databaseName` was never policy-controlled, and `branchName` just repeats the command's target branch on every row). `bucket` / `function` changes keep their meaningful fields (`accessLevel`, `name`, `source`, `runtime`, …) but drop the redundant `branchName`. Plan and apply stay in sync.
- 6b4a26f: Stop generating a source map for deployed function bundles.

  `buildFunctionBundle` ran esbuild with `sourcemap: true`, shipping an `index.mjs.map` in every deploy archive. The Functions runtime does not run Node with source-map support, so the uploaded map is never consumed (a thrown error's stack still points into the minified `index.mjs`). It only inflated the archive, so it is no longer emitted.

- 11c14e6: Name the function bundle entry `index.mjs` instead of `out.js`.

  `buildFunctionBundle` emitted the esbuild output as `out.js` / `out.js.map`, but the Functions
  runtime imports the deploy archive's entry by the conventional `index.{js,mjs}` name — so a
  deployed function's zip had no importable module. The default bundler now emits
  `index.mjs` / `index.mjs.map`.

- b6efa3a: Surface each deployed function's invocation URL in `plan` / `apply` results.

  `pushConfig` now adds an `invocationUrl` to the `details` of every `function:<slug>` change in `PushResult.applied`, so callers (e.g. `neonctl deploy`) can show users where to call a function right after deploying it. The URL comes from the preview state already fetched for the diff; a function created by its first deployment in the same push triggers a single extra `listBranchFunctions` to learn its freshly-minted URL (best-effort — a failed re-list simply omits the URL).

- c57536b: Honor `NEON_API_HOST` / the new `apiHost` option when building the default Neon API client. `createNeonApiFromOptions` now resolves the host (explicit `apiHost` option → `NEON_API_HOST` env → production default), and `pullConfig`, `pushConfig`, `inspect`/`plan`/`apply`, and `fetchEnv` accept and forward an optional `apiHost`.
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

## 0.2.2

### Patch Changes

- Only probe the Preview features a policy declares, and don't let an unavailable Preview feature break read paths. `pushConfig` (`plan` / `apply`) now reads remote bucket / function / AI Gateway state **only** for the features the `neon.ts` policy uses — so it fails on a `PLATFORM_FEATURE_UNAVAILABLE` (404/503) only when the policy actually asks for that feature. `pullConfig` (`inspect`, and the env resolution behind `neon dev` / `neon env pull`) degrades an unavailable Preview feature to "none / disabled" instead of throwing, so env (DATABASE_URL + Auth / Data API) is still pulled.
- Updated dependencies
  - @neondatabase/config@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [ff7103b]
  - @neondatabase/config@0.2.0

## 0.2.0

### Minor Changes

- 135a173: `apply` / `pushConfig` now accept an optional `bundleFunction` ({@link FunctionBundler}) so the caller can supply its own function bundler. When omitted, the default lazily `import()`s the esbuild-backed `buildFunctionBundle`, keeping esbuild out of `config-runtime`'s static module graph — so a consumer that injects its own bundler (e.g. neonctl, which already ships esbuild) never drags a second copy into its packaged snapshot. Exports the `FunctionBundler` type from `v1`.
- 5ddace9: `pullConfig` now reverse-engineers the branch's **Neon Auth** and **Data API** enablement into the returned `config` (`config.auth = {}` / `config.dataApi = {}` when each integration is enabled on the branch). Previously only branch/postgres settings and the `preview` block (buckets, functions, AI Gateway) were surfaced, so a config pulled from a branch with Auth or Data API enabled did not round-trip through `resolveConfig` / `fetchEnv` — and the matching `NEON_AUTH_BASE_URL` / `NEON_DATA_API_URL` secrets were never injected. Data API is enabled per branch + database, so `pullConfig` probes the branch's default database (`neondb`, else the first database) to detect it.

## 0.1.0

### Minor Changes

- Initial release of `@neondatabase/config-runtime` — the imperative runtime for `@neondatabase/config`. Reads a branch's live state, diffs a policy against it, applies changes, and bundles + deploys Neon Functions. Function bundling pulls in `esbuild`, so this is the package CLIs and CI import — keeping `esbuild` out of the dependency tree of anyone who only imports `defineConfig` from `neon.ts`.

  - `inspect` / `plan` / `apply` (Terraform-style), plus the lower-level `pushConfig` / `pullConfig` engine.
  - Preview features are applied **additively** (buckets and functions are created and the AI Gateway is enabled; nothing is auto-deleted), and `inspect` / `pullConfig` reports a branch's live Preview state.
  - `buildFunctionBundle` — bundles a function's `source` with esbuild and zips it for deploy.
