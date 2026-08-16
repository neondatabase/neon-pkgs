# @neon/env

Resolve and inject Neon connection strings for the branch selected by your `neon.ts` policy. Exposes `fetchEnv` / `parseEnv` functions plus a `neon-env` CLI with `run` (inject env into a command) and `export` (print env to stdout).

Builds on [`@neon/config`](../config) — it reuses the `Config` policy type and the Neon API client.

## Install

```bash
npm install @neon/env
```

> **Requirements:** Node.js >= 20.19.

## What's in it

Everything is on `@neon/env`, and none of it has side effects: `fetchEnv` asks the Neon API for a branch's env, `parseEnv` validates what was already injected into `process.env`, `toEntries` projects a resolved env into `{ KEY: value }`. Nothing here writes a file, mutates `process.env`, or creates or destroys anything on your Neon project — so importing this package from an app, a build script, or a `neon.ts` policy can't surprise you.

> **`@neon/env/runtime` was removed in 0.16.0.** It held `fetchEnvReusingSecrets`, which reads an env source and can mint and revoke branch credentials — implementation shared with the `neon` CLI, not something to hand an application. If you were importing it, the [`neon` CLI](../cli) (`neon env pull`, `neon dev`) does the same job; if you need to do it yourself, [The branch credential](#the-branch-credential) says what the hard part actually is.

Contributing? See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Functions

The library functions are **filesystem- and env-agnostic**: `fetchEnv` requires an explicit `projectId` + `branch` (a branch **name** like `main`, or a `br-…` id). (The `neon-env` CLI does the `.neon`/`NEON_*` resolution and passes these in.)

> `parseEnv` takes **no branch name**: the secret set is static (top-level `config.auth` / `config.dataApi`), so it reads those toggles directly without evaluating the per-branch closure. Its optional second argument is a **scope** _or_ a **key filter** — omit it for the full external (app/build) env, pass a **function slug** when running inside that deployed function (adds a typed `function` namespace of its declared env keys), or pass an **array of OS-level env-var keys** to require + return only that subset.

```ts
import config from "../neon";
import { fetchEnv, parseEnv } from "@neon/env";

// Async — calls the Neon API for live connection strings. Use in build scripts / top-level await.
const env = await fetchEnv(config, { projectId: "patient-art-12345", branch: "main" });
const db = drizzle(neon(env.postgres.databaseUrl), { schema });

// Sync — reads already-injected process.env and validates it (no network).
// Use in app bootstrap where async isn't available.
const env2 = parseEnv(config);

// Inside a deployed function, pass its slug for the typed `function` namespace:
const fnEnv = parseEnv(config, "hello");
fnEnv.function.resendApiKey; // typed from hello's declared env keys

// Key filter — only enforce + return the vars you actually use (e.g. a Next.js app that
// reads the pooled URL but not the unpooled one). The keys autocomplete from the policy, so
// you can only select vars the policy enables, and the result is narrowed to match:
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
postgres.databaseUrl; // string — `databaseUrlUnpooled` is absent, and never required
```

Both return the same namespaced `NeonEnv` shape: `postgres` is always present; `branch` (the branch name, surfaced as `NEON_BRANCH`) is always present on a `fetchEnv` result and present on a `parseEnv` result when `NEON_BRANCH` was injected; `auth` and `dataApi` are included (and statically typed) when the evaluated branch policy enables them.

| Function | Description |
| --- | --- |
| `fetchEnv(config, { projectId, branch, ... })` | Async. Calls the Neon API for the given project + branch and returns live connection strings (and Auth/Data API values when enabled). `projectId` and `branch` are required; `branch` accepts a branch **name** (e.g. `main`) or a `br-…` id. (The legacy id-only `branchId` option still works.) Pass `keys` to fetch only some vars — see [Fetching a subset](#fetching-a-subset). Reads nothing from `process.env` or disk. |
| `parseEnv(config)` / `parseEnv(config, slug)` / `parseEnv(config, keys)` | Sync. Reads/validates the Neon env vars already present in `process.env` against the static policy toggles. With a function `slug`, also returns a typed `function` namespace of that function's declared env keys. With a `keys` array (e.g. `["DATABASE_URL"]`), only those vars are required and returned, as a narrowed namespaced shape — the keys are typesafe against the policy. Throws `PlatformError(EnvNotInjected)` listing missing vars when the env isn't populated. |
| `toEntries(env)` | Project a resolved `NeonEnv` into `{ KEY: value }` pairs for cross-process transport (named after the web `.entries()` convention; returns a `Record`). |

## CLI

### `run` — inject env into a command

Inject the env vars for your `neon.ts` branch into a dev command:

```bash
neon-env run -- npm run dev
neon-env run -- pnpm dev
```

`run` loads `neon.ts`, resolves the branch (via `--branch`, `NEON_BRANCH` / `NEON_BRANCH_ID`, or the `branch` field in `.neon[/project.json]` — by name or id), fetches the connection strings from Neon, and spawns the command with `NEON_BRANCH` / `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (plus the Auth, Data API, object-storage `AWS_*`, and AI Gateway `NEON_AI_GATEWAY_*` vars when the policy enables them — see [Env vars produced](#env-vars-produced)) injected on top of the inherited environment. Stdio is inherited so interactive dev servers keep working, and the parent exits with the child's exit code.

### `export` — print env to stdout

Resolve the same branch env, but print it instead of spawning a process — for piping into other env tools:

```bash
neon-env export                 # dotenv KEY=value lines (default)
neon-env export --format json   # JSON object
```

For example, [varlock](https://varlock.dev) can bulk-load Neon's branch env via its `exec()` resolver:

```bash
# .env.schema
# @setValuesBulk(exec(`neon-env export --format json`), format=json)
```

Flags (both commands): `--config <path>`, `--project-id`, `--branch`, `--api-key`, `--profile`, `--debug`. `export` also takes `--format dotenv|json`.

`--api-key` and `NEON_API_KEY` skip stored credentials. Otherwise `neon-env` reads the same
Neon CLI profile the `neon` CLI does, including a secret stored in the OS keyring when that
profile's `profiles.json` pointer is `"keyring"`. `@neon/env` has no standalone binary; it
loads the OS keyring addon from npm. If that optional dependency is missing, a `"keyring"`
pointer is an error. Older releases treat the sentinel as a relative path. A keyring pointer
whose item cannot be read is an error, not "not signed in".

## Env vars produced

These are the OS-level vars `fetchEnv` / `parseEnv` read and `toEntries` (so `neon-env run` / `neon-env export` / `neon env pull`) emit. Which ones appear depends on what your `neon.ts` policy enables — grouped by service below.

**Branch identity + Postgres** (always present):

| Key | From |
| --- | --- |
| `NEON_BRANCH` | the resolved branch **name** — mirrors what the Neon Functions runtime injects on every branch, so local dev matches the deployed runtime |
| `DATABASE_URL` | pooled connection string |
| `DATABASE_URL_UNPOOLED` | direct connection string |

**Neon Auth** (when `auth` is enabled):

| Key | From |
| --- | --- |
| `NEON_AUTH_BASE_URL` | Neon Auth integration base URL (doubles as the publishable client identifier) |
| `NEON_AUTH_JWKS_URL` | Neon Auth JWKS endpoint for verifying issued tokens |

**Data API** (when `dataApi` is enabled):

| Key | From |
| --- | --- |
| `NEON_DATA_API_URL` | Data API (PostgREST) integration URL |

**Object storage** (Preview — when `preview.buckets` declares at least one bucket). Projected onto the AWS SDK's standard config vars so an S3 client works from env alone (set `forcePathStyle: true`):

| Key | From |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | branch credential's full token id (e.g. `nak_live_…`) |
| `AWS_SECRET_ACCESS_KEY` | branch credential's S3 secret access key |
| `AWS_ENDPOINT_URL_S3` | branch's S3-compatible endpoint URL |
| `AWS_REGION` | branch region (e.g. `us-east-2`) |

**AI Gateway** (Preview — when `preview.aiGateway` is enabled). Emitted under the Neon-branded vars the deployed Functions runtime injects; clients like [`@neon/ai-sdk-provider`](../ai-sdk-provider) read these and append the `/ai-gateway/<dialect>/…` routes themselves:

| Key | From |
| --- | --- |
| `NEON_AI_GATEWAY_TOKEN` | branch credential's API token (bearer) |
| `NEON_AI_GATEWAY_BASE_URL` | bare branch gateway host (`https://<branch>-api.ai.<region>.…`, no path) |

### The branch credential

Object storage and the AI Gateway are backed by one branch credential, and the Neon API returns its secrets (`s3_secret_access_key`, `api_token`) **once**, at mint time — they aren't stored server-side, and the list endpoint returns metadata only. So there is nothing to *fetch*: `fetchEnv` mints. Call it on every `neon dev` start and you leave a live credential behind each time.

Handling that is the caller's problem, and it is not just "cache the secret": a persisted secret is only reusable if it still names a live credential on that branch — unrevoked, unexpired, and carrying every scope the policy needs. A presence check cannot tell a real secret from a `.env.example` placeholder.

No local bookkeeping is needed to do it, because the secrets carry their own credential id: `AWS_ACCESS_KEY_ID` **is** the credential's token id, and the AI Gateway token is minted as `nt_live_<tokenIdShort>_<secret>`. So the `.env` you are about to rewrite already records which credential issued it.

The [`neon` CLI](../cli) does all of this — `neon env pull` and `neon dev` reuse a branch credential rather than issuing one per run. If you are calling `fetchEnv` on a loop yourself, `credentialScopesSatisfied` and `deriveCredentialScopes` from `@neon/config/v1`, plus `listCredentials` / `createCredential` / `revokeCredential` on a `NeonApi`, are the pieces you need.

### Fetching a subset

`fetchEnv` takes a `keys` filter, the same typesafe selection `parseEnv` accepts:

```ts
const { storage } = await fetchEnv(config, {
    projectId,
    branch: "main",
    keys: ["AWS_ENDPOINT_URL_S3", "AWS_REGION"],
});
storage.endpoint; // string — `accessKeyId` is absent, and never fetched
```

Inline key arrays autocomplete from the services enabled in `config`, reject unknown or disabled keys, and narrow the result exactly without `as const`. A runtime-built array returns the same selected values with optional namespaces and properties, because the array may contain any subset of its declared key union:

```ts
const keys: Array<"DATABASE_URL" | "NEON_BRANCH"> =
    process.env.INCLUDE_BRANCH ? ["DATABASE_URL", "NEON_BRANCH"] : ["DATABASE_URL"];
const selected = await fetchEnv(config, { projectId, branch: "main", keys });

selected.postgres?.databaseUrl; // string | undefined
selected.branch?.name; // string | undefined
```

`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are one credential and must be selected together. Literal lists that contain only one half are a type error; a runtime-built list that resolves to one half throws before any API request or credential issuance.

Work is skipped, not just the result narrowed. Leave out `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `NEON_AI_GATEWAY_TOKEN` and **no credential is minted at all** — which is exactly how `fetchEnvReusingSecrets` refreshes everything else while keeping secrets you already have. The non-secret vars of those features (`AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `NEON_AI_GATEWAY_BASE_URL`) are branch metadata and stay available on their own.

## Connection role & database selection

When `roleName` / `databaseName` aren't passed, `fetchEnv` (not `parseEnv`, which reads an already-resolved `DATABASE_URL`) auto-picks them:

- **Role** — the sole role, else `neondb_owner`, else the single role left after dropping the managed `authenticator` / `anonymous` / `authenticated`. More than one app role throws.
- **Database** — `neondb` if present, else the sole database. Several databases with no `neondb` throws (pass `databaseName` to disambiguate) rather than guessing.

Pass `databaseName` / `roleName` to override the auto-pick.

## Resolution

The **CLI** (`neon-env run`) resolves project + branch itself: `--project-id` / `--branch` flag → `NEON_PROJECT_ID` / `NEON_BRANCH` (name) / `NEON_BRANCH_ID` (legacy id) env → `.neon[/project.json]` walked up from the working directory (its `branch` field, name or id; legacy `branchId` still read). The API key resolves via `--api-key` → `NEON_API_KEY` → `~/.config/neonctl/credentials.json`.

The **library functions** do none of this — pass `projectId` / `branch` explicitly. This keeps `.neon` parsing in one place (the CLI / neon) and the functions pure.
