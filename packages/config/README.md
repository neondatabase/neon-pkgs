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
  dataApi: true,
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

### Shipping a prebuilt directory (`bundler: "none"`)

esbuild is the default. A file `source` is the entry; a directory is searched for `index.ts`, then `index.js`, then `index.mjs`. Set `bundler: "none"` to zip `source` as-is instead — a directory whose root contains `index.mjs` or `index.js`, or a single file of that name:

```ts
export default defineConfig({
  preview: {
    functions: {
      mastra: {
        name: "Mastra server",
        source: ".mastra/output",
        bundler: "none",
      },
    },
  },
});
```

`neon function deploy mastra --src .mastra/output --no-bundle` is the same switch without a `neon.ts`. TypeScript cannot be shipped unbundled.

### Shipping a dependency's files (`externalPackages`)

A function's `source` is bundled with esbuild at deploy time, and a package backed by a native `.node` binary cannot be bundled by anything: the binary is a compiled object the platform loads from a real path. `sharp` is the common case, and it does not even fail the build — it loads its binary through `createRequire`, which esbuild does not follow, so it bundles cleanly and then fails at invoke with `Could not load the "sharp" module`.

`externalPackages` is the deploy-time counterpart of Next.js's `serverExternalPackages`. Every entry is passed to esbuild's `external`, so the import survives into the bundle instead of being followed, and the package's own files are shipped into the archive beside the bundle so that import resolves:

```ts
export default defineConfig({
  preview: {
    functions: {
      resize: {
        name: "Resize",
        source: "./functions/resize.ts",
        externalPackages: ["sharp"],
      },
    },
  },
});
```

Each declared package is installed for the Functions runtime target — **linux-arm64, glibc** — into a throwaway directory, traced for the files it actually reaches, and copied into the archive under `node_modules/` with its directory layout intact. The layout matters: a `.node` addon finds its sibling shared libraries relative to its own directory, so a flattened tree fails to load.

Your own `node_modules` is never read for those files or modified. Its binaries are built for your machine rather than the deploy target, and a cross-platform install does not survive your next plain `npm install`, so the target's packages are resolved fresh on each deploy.

Requirements, all checked at deploy time rather than left to fail at invoke:

- the package is installed in your project — the deploy stages the version you have, and refuses rather than guessing one
- the package publishes a linux-arm64 glibc build (`sharp` and most `@napi-rs/*` packages do; anything compiled from source at install time does not)
- `npm` is on `PATH`
- the archive stays within the deploy size limits — native binaries are large, so a couple of them is the practical ceiling

#### When the deploy warns about a package you did not declare

A deploy (and `neon dev`) reports a package it bundled that carries native code and is not in
`externalPackages`, because such a package deploys cleanly and then fails at invoke — `sharp`
produces no build error at all.

**The report is advisory and never fails a deploy.** It can only see that the package contains
compiled code, not whether your function reaches it. A package with a native accelerator behind
a working JavaScript fallback — `ws` with `bufferutil` installed is the common one — is reported
and is already correct; no change is needed.

Do not use `includeFiles: false` to silence it. That externalizes the package and ships nothing
for it, so an import that *is* reached then fails on every invoke.

#### Excluding a package's files

`includeFiles: false` externalizes an import without shipping anything for it. That is the escape hatch for a package that cannot be staged — no build for the runtime target, or too large — and that the function never actually reaches:

```ts
externalPackages: ["sharp", { name: "canvas", includeFiles: false }],
```

**An excluded package is not resolvable at runtime.** Nothing is shipped for it, so it throws `Cannot find module` if the function reaches it. It unblocks an import that is never evaluated; it does not make a dependency usable.

Entries are package names, optionally with a subpath (`pkg`, `@scope/pkg`, `pkg/sub`). A relative or absolute path is rejected at validation time. Files are staged per package, so a subpath narrows what esbuild leaves unresolved without narrowing what ships.

Under `neon dev` the list only keeps the package out of the bundle. Nothing is installed or copied, and it resolves from your own `node_modules` against your host architecture — which is what you want locally.

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
- `auth: {}` and `dataApi: {}` enable those integrations with Neon defaults. Absence of `dataApi` leaves an existing Data API alone. `dataApi: false` / `dataApi.enabled: false` disables it (an override: `updateExisting` or `confirm`). `auth.enabled: false` still leaves Auth alone.
- Mutable branch drift (`protected`, `ttl`, `postgres.computeSettings`) is reported as a conflict unless `updateExisting` is passed (or a `confirm` callback is supplied to `pushConfig`).
- Applying to a branch with the `protected` flag set on Neon requires `allowProtectedBranch` (or a `confirm` callback).

## Env vars

Connection-string resolution/injection lives in the companion package [`@neon/env`](../env), which depends on this package for the `Config` type and the Neon API client.
