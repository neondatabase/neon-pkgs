# @neon/config

Config-as-Code for Neon. A repo-local `neon.ts` exports a TypeScript policy function describing a branch's desired state. This package exposes **functions** to inspect, diff, and deploy that policy against the Neon API.

> No CLI commands ship here, and the package is **filesystem- and env-agnostic**: it never reads `.neon` files or `NEON_*` environment variables. You pass `projectId` and the target branch explicitly (resolve them in your CLI, e.g. neon). This package is functions only.

## Install

```bash
npm install @neon/config
```

> **Requirements:** Node.js >= 20.19.

## Define a policy

```ts
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Static: what *exists* on every branch. GA service toggles drive the typed env.
  auth: true,
  dataApi: false,
  // Beta (Preview) features, keyed by slug / name.
  preview: {
    functions: {
      hello: { name: "Hello", source: "./functions/hello.ts", dev: { port: 8787 } },
    },
  },
  // Dynamic: per-branch tuning only. Cannot add/remove services or functions.
  branch: (branch) => ({
    protected: branch.name === "main",
    ...(branch.name === "main" ? {} : { parent: "main", ttl: "7d" }),
  }),
});
```

A policy is split into a **static** existential set and a **dynamic** `branch` closure:

- **Static top-level** — `auth` / `dataApi` (GA service toggles) and the beta `preview` block (`aiGateway`, `functions` keyed by slug, `buckets` keyed by name). Because this is static, the secret set is known at the type level, so `parseEnv` / `fetchEnv` from `@neon/env` return an exact `NeonEnv`.
- **`branch` closure** — receives a **read-only descriptor** (`BranchTarget`) of the branch being evaluated (`name`, `id`, `exists`, `isDefault`, `isProtected`, `parentId`, `expiresAt`) and returns per-branch *tuning*: `parent`, `ttl`, `protected`, `postgres.computeSettings`, and per-function `runtime`. Function memory is fixed at `2048` MiB for now and is not user-configurable. It runs both against existing branches and during pre-create evaluation (`exists: false`). It **cannot** change which services or functions exist — that is what keeps the static secret set sound.

Service toggles accept `true` / `{}` / `{ enabled: true }` (enabled) and `false` / `{ enabled: false }` (disabled). Function slugs (record keys) must match `^[a-z0-9]{1,20}$`.

### Unbundleable dependencies (`externalPackages`)

A function's `source` is bundled with esbuild at deploy time, and some packages cannot be bundled at all: a native `.node` addon has no esbuild loader, and a library may reference an optional peer dependency on a code path the function never takes. Either one fails the deploy with a resolve or loader error naming the package, and neither is fixable from the function's own source.

`externalPackages` is the escape hatch, and the deploy-time counterpart of Next.js's `serverExternalPackages` — every entry is passed to esbuild's `external`, so the import survives into the bundle instead of being followed:

```ts
export default defineConfig({
  preview: {
    functions: {
      agent: {
        name: "Agent",
        source: "./functions/agent.ts",
        externalPackages: ["microsandbox", "@mongodb-js/zstd"],
      },
    },
  },
});
```

**An external package is not resolvable at runtime.** The deployed archive is a single `index.mjs` with no `node_modules` beside it, so anything listed here throws `Cannot find module` if the function actually reaches it. The option unblocks an import that is never evaluated; it does not make a dependency usable.

A dependency the handler actually calls has to be bundled, and whether that is possible depends on what it is:

- **Pure JavaScript** — bundling is the normal case, and a failure is usually something specific and fixable in the entry.
- **Backed by a native `.node` binary** — cannot be bundled by any bundler; the binary is a compiled object the platform loads from a real path. Such a package cannot work on Functions until the archive can carry files alongside the bundle. Listing it here does not help, it only moves the error from deploy to invoke.

A native package may also bundle without needing this option at all. `sharp` loads its binary through `createRequire`, which esbuild does not follow, so it bundles cleanly and then fails at invoke with `Could not load the "sharp" module`.

Entries are package names, optionally with a subpath (`pkg`, `@scope/pkg`, `pkg/sub`). A relative or absolute path is rejected at validation time. `neon dev` applies the same list, so a local run bundles like a deploy.

### Data API

`dataApi` accepts the same boolean/toggle forms **or** an object that selects the auth provider and reusable runtime `settings`:

```ts
export default defineConfig({
  auth: true, // required when the Data API verifies Neon Auth tokens
  dataApi: {
    // "neon" (default) verifies Neon Auth tokens; "external" verifies a third-party IdP.
    authProvider: "neon",
    settings: {
      dbSchemas: ["public", "api"],
      dbMaxRows: 1000,
      // dbAnonRole, dbExtraSearchPath, jwtRoleClaimKey, jwtCacheMaxLifetime,
      // openapiMode ("ignore-privileges" | "disabled"), serverCorsAllowedOrigins,
      // serverTimingEnabled — all optional, camelCase mirrors of the Neon API.
    },
  },
});
```

```ts
// External IdP (Clerk / Stytch / Auth0 / …): you provide the JWKS wiring, and no Neon Auth is required.
export default defineConfig({
  dataApi: {
    authProvider: "external",
    jwksUrl: "https://your-idp.example.com/.well-known/jwks.json",
    providerName: "Clerk", // optional label
    jwtAudience: "my-api", // optional; only *rejects* tokens with a different `aud`
    settings: { dbSchemas: ["public"] },
  },
});
```

Two invariants are enforced **both** at author time (TypeScript) and at runtime (zod):

- **`authProvider: "neon"` requires Neon Auth.** A Neon-verified Data API needs `auth` enabled on the same branch (so the tokens it verifies exist). `jwksUrl` / `providerName` / `jwtAudience` are forbidden on this variant — Neon supplies them.
- **`authProvider: "external"`** is where `jwksUrl` / `providerName` / `jwtAudience` live, and it does **not** require Neon Auth.

The auth wiring (`authProvider`, `jwksUrl`, …) is set when the Data API is first **enabled** and is immutable afterwards. The runtime `settings` are reconcilable: changing them is treated as an **update** and requires `updateExisting: true` (`apply`) / `--update-existing` (CLI), like compute/TTL/`protected` drift.

## Functions

The three operations mirror the Terraform mental model: **`inspect`** (read live state), **`plan`** (dry-run diff), **`apply`** (reconcile).

`projectId` and `branchId` are **required** — there is no `.neon`/env fallback. (`projectId` is required because the Neon management API addresses every branch through its project; deriving it from a branch id would need an extra discovery round-trip.)

```ts
import config from "../neon";
import { inspect, plan, apply } from "@neon/config/v1";

const target = { projectId: "patient-art-12345", branchId: "main" };

// Dry-run: what would apply do for this branch? No mutations.
const diff = await plan(config, target);

// Apply the policy to a branch. Never creates projects/branches.
await apply(config, { ...target, updateExisting: true });

// Read a branch's live Neon state as a plain object.
const live = await inspect(target);
```

| Function | Description |
| --- | --- |
| `inspect(options)` | Returns the branch's live Neon state (project + branch metadata and a reverse-engineered `BranchConfig`). Read-only. |
| `plan(config, options)` | Returns the dry-run diff — what `apply` would do for the branch, with no mutations. Returns a `PushResult` whose `applied` holds the plan and `conflicts` holds blocking drift. |
| `apply(config, options)` | Reconciles your local `neon.ts` policy onto the branch. Pass `updateExisting` to auto-confirm overriding existing remote settings and `allowProtectedBranch` to auto-confirm applying to a protected branch. |

`options` requires both `projectId` and `branchId` (a Neon branch id, `br-…`). Resolve branch names to ids before calling.

**Pass `apiKey` explicitly** (or inject your own `api` adapter). This package reads no environment variables and no files on your behalf — it will not pick up `NEON_API_KEY` or `~/.config/neonctl/credentials.json`, and omitting the key raises `PLATFORM_MISSING_API_KEY`. Resolving where a credential comes from belongs to the application or CLI embedding this package, because only it knows which ambient sources its users expect. `packages/cli` and `packages/env`'s `neon-env` both implement that chain; the latter's `src/lib/cli/resolve-api-key.ts` is a ~60-line reference implementation of flag → `NEON_API_KEY` → stored credentials.

## Lower-level engine

`inspect` / `plan` / `apply` are thin wrappers over `pullConfig(options)` / `pushConfig(config, options)` (both require `projectId` + `branchId`), which are also exported for advanced/programmatic use along with `defineConfig`, `loadConfigFromFile` (optional `neon.ts` loader), `createRealNeonApi`, the `PlatformError` base class + `ErrorCode` enum, the `errors` and `schemas` namespaces, and the supporting types.

```ts
import {
  defineConfig,
  inspect,
  plan,
  apply,
  pushConfig,
  pullConfig,
  loadConfigFromFile,
  createRealNeonApi,
  PlatformError,
  ErrorCode,
  errors,
  schemas,
} from "@neon/config/v1";
```

## Safety Rules

- `apply` / `pushConfig` never creates projects or branches.
- `auth: {}` and `dataApi: {}` enable those integrations with Neon defaults. `auth.enabled: false`, `dataApi.enabled: false`, or absence leaves existing integrations alone. Disabling is destructive and remains explicit/manual.
- Mutable branch drift (`protected`, `ttl`, `postgres.computeSettings`) is reported as a conflict unless `updateExisting` is passed (or a `confirm` callback is supplied to `pushConfig`).
- Applying to a branch with the `protected` flag set on Neon requires `allowProtectedBranch` (or a `confirm` callback).

## Env vars

Connection-string resolution/injection lives in the companion package [`@neon/env`](../env), which depends on this package for the `Config` type and the Neon API client.
