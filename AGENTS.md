# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a monorepo of [Neon](https://neon.com) open-source packages for the JavaScript/TypeScript
ecosystem (CLIs, a Vite plugin, the Config-as-Code toolchain, and runtime helpers).

For the list of packages and their status, see the top-level `README.md` (maintained packages)
and each package's own `README.md` — **the per-package README is the single source of truth for
whether a package is maintained or deprecated** (deprecated packages carry a banner at the top).
Don't duplicate that list here.

## Development Commands

### Building

```bash
# Build every package in the workspace
pnpm build

# Build the neon-new CLI only
pnpm build:cli

# Build the vite-plugin-neon-new plugin only
pnpm build:plugin
```

### Testing

```bash
# Run all tests
pnpm test:ci

# Run tests for a specific package
pnpm --filter neon-new test
pnpm --filter vite-plugin-neon-new test
```

See [CONTRIBUTING.md's Testing section](CONTRIBUTING.md#testing) for local test semantics,
the pull-request CI sharding layout, and the coverage artifact handoff.

#### Live Neon e2e tests

`pnpm test:e2e:live` runs the `@neon/sdk`, `@neon/config`, `@neon/config-runtime`,
`@neon/env`, and `neon` (the CLI) e2e suites against the **real Neon Management API**. They
create Postgres projects, mutate branches, read connection strings, and delete
everything again. They are excluded from `pnpm test:ci` (each package's Vitest config
excludes the e2e files) and only run through their own `test:e2e` script.

Run them against a **dedicated throwaway organization** — never a personal or
production one. The suite sweeps stale `neon-ts-e2e-*` projects on start, so any
project matching that prefix in reach of the key is fair game for deletion.

```bash
cp packages/sdk/.env.example .env   # repo root: one file for all five suites
# Fill in NEON_API_KEY with an org-scoped key for the throwaway org.
# Set NEON_ORG_ID too when the key is user-scoped, so the sweep stays inside one org.
pnpm test:e2e:live
```

| | |
| --- | --- |
| **Workflow** | `.github/workflows/e2e-live.yml` — every PR, every push to `main`, plus `workflow_dispatch` |
| **Org** | `org-autumn-tree-56376911` ("neon-pkgs Integration Test Org"), Launch plan |
| **Skipped for** | Fork and Dependabot PRs — GitHub does not expose repository secrets to untrusted PR code |
| **Runner** | Protected runner group. The Neon API is reachable from it. |

The org needs the **Launch plan or above**: `lifecycle.e2e.test.ts` protects a branch
through `pushConfig`, and the free plan allows zero protected branches.

##### Environment variables

Every variable the live suites read, and where it comes from:

| Variable | Required | Read by | Meaning |
| --- | --- | --- | --- |
| `NEON_API_KEY` | yes | all five suites, via `requireApiKey()` | Org-scoped key for the throwaway org |
| `NEON_ORG_ID` | recommended | harness `configuredOrgId()`; the CLI suite maps it to `--org-id` | Pins create, list and sweep to one org. **Required in practice for a user-scoped key**, or the sweep ranges over every org the key can see |
| `NEON_PROJECT_ID` | only for project-scoped keys | harness `detectApiKeyScope()` | Targets a fixed project; create-paths skip themselves |
| `NEON_API_BASE_URL` | no | harness `api.ts` | Point the harness at a non-production API. Defaults to `https://console.neon.tech/api/v2` |
| `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN` | no | `@neon/ai-sdk-provider` | Run the gateway suite against a branch you already have. Set both or neither; with neither, that suite provisions its own from `NEON_API_KEY` |

**Resolution order**, highest priority first — implemented in the harness's `loadEnv`:

1. A real environment variable. Always wins; this is how CI injects secrets with no
   file on disk.
2. The package's own `.env` (`packages/sdk/.env`, …). Use this only to override one
   suite.
3. A `.env` at the repository root. The normal place to put credentials — all five
   suites read it, so you configure them once.

`.gitignore` covers `.env` and `.env.*` with a `!.env.example` negation, so the
examples stay tracked and real credentials cannot be committed. Never add a `.env` to
a commit, even a "redacted" one.

**Getting an org-scoped key:** create the key in the Neon console under the throwaway
org's settings, or via the API with a token for an account that administers it:

```bash
curl -X POST "https://console.neon.tech/api/v2/organizations/<org-id>/api_keys" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"key_name":"neon-pkgs-ci-e2e"}'
```

Org-scoped is strongly preferred over user-scoped: the key can only see the throwaway
org, so the orphan sweep physically cannot reach anything else.

##### How CI supplies them, and adding a new one

The workflow maps repository secrets and variables onto the same env var names the
suites read locally, so there is one contract rather than two:

```yaml
env:
    NEON_API_KEY: ${{ secrets.NEON_TEST_API_KEY }}
    NEON_ORG_ID: ${{ vars.NEON_TEST_ORG_ID }}
```

**Secret or variable?** Secret if leaking it grants access to something — API keys,
tokens, passwords. Variable if it's an identifier you would happily paste into a PR
description, like an org id. Variables are readable in logs and in the Actions UI,
which makes debugging a misconfigured run much easier, so don't reach for a secret out
of habit.

To wire up a **new** variable end to end:

1. **Read it through the harness**, not `process.env` scattered across tests. Add an
   accessor in `tests/e2e-harness/src/env.ts` next to `configuredOrgId()` so the
   default and the "missing" error message live in one place.
2. **Document it in every `.env.example`** — `packages/{sdk,config,config-runtime,env,cli}/.env.example`.
   They are near-identical on purpose: a contributor copies whichever one they find.
3. **Add it to the table above** and, if contributors need it, to `CONTRIBUTING.md`.
4. **Store it on the repository** (needs admin on `neondatabase/neon-pkgs`):

   ```bash
   gh secret set NEON_TEST_SOMETHING   --repo neondatabase/neon-pkgs --body "<value>"
   gh variable set NEON_TEST_SOMETHING --repo neondatabase/neon-pkgs --body "<value>"
   ```

5. **Map it in the workflow's `env:` block** in `.github/workflows/e2e-live.yml`,
   using the local name as the key and `secrets.*` / `vars.*` as the value.
6. **Verify on a PR from this repository.** Fork PRs get neither secrets nor variables,
   so the job is skipped there and a green fork run proves nothing about the wiring.

Prefer making a new variable **optional with a sane default**. A required variable
breaks every existing checkout the moment it lands, and the failure surfaces as a
confusing mid-suite error rather than a clear setup message.

Suites run one at a time (`--workspace-concurrency=1`) because they share one org, and
with `--no-bail` so one failure neither hides the other suites' results nor aborts a
suite that has already started creating projects. Across concurrent CI runs, safety
comes from the sweep ignoring projects younger than an hour, so a sibling run's
in-flight project is never deleted underneath it.

##### The AI Gateway suite (`@neon/ai-sdk-provider`)

`pnpm --filter @neon/ai-sdk-provider test:e2e` is the sixth live suite. It runs as its own
workflow rather than inside `test:e2e:live`:

| | |
| --- | --- |
| **Workflow** | `.github/workflows/e2e-gateway.yml` — path-filtered to `packages/ai-sdk-provider/**` and `tests/e2e-harness/**`, plus pushes to `main` and `workflow_dispatch` |
| **Why separate** | A run makes well over a hundred inference requests: `sdk-version-matrix` generates text with **every** model the branch serves on both AI SDK 6 and 7. Attaching that to every pull request would spend on changes it cannot cover |
| **Credentials** | The same `NEON_TEST_API_KEY`. **No gateway token is stored** |

`e2e/global-setup.ts` supplies the gateway one of two ways and fails if it can do neither —
there is deliberately no skip path, because a gateway suite that runs zero tests and reports
green is the failure this workflow exists to prevent:

1. `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN`, for a branch you already have. Both
   or neither; one alone throws rather than half-configuring the run.
2. `NEON_API_KEY` — it creates a throwaway project, mints a branch credential scoped to
   `ai_gateway:invoke`, derives the branch's gateway host, and revokes then deletes both
   afterwards.

Three things make that work, and each one is a fact about the platform rather than a choice:

- **The gateway needs no provisioning.** It exists on every branch. `preview.aiGateway` in a
  `neon.ts` policy produces no plan step — it only widens the branch credential's scope and
  adds the two env vars to what `@neon/env` emits.
- **The token is minted, not stored.** `POST /projects/{id}/branches/{branch}/credentials`
  returns `api_token` exactly once. Storing one as a repository secret would only give it time
  to go stale, so setup masks it with `::add-mask::` and revokes it in teardown.
- **Model access is per account, not per project**, so a throwaway project sees the same
  catalog as any other in the org. It follows that the catalog is also what breaks: the org
  needs every id in `MATRIX_MODELS`, and "serves every model the matrix pins" fails with the
  missing ids when it doesn't. Without that assertion the per-family `skipIf` would quietly
  shrink coverage to nothing.

It imports the harness **by subpath** (`@neon/e2e-harness/projects`, `/api`, `/env`), never the
barrel: the barrel re-exports the `e2eTest` fixture, which imports `vitest`, and Vitest runs
`globalSetup` outside a worker where that throws.

##### The shared harness (`tests/e2e-harness`)

`@neon/e2e-harness` is a **private, never-published** workspace package holding the
plumbing every live suite needs: the `.env` contract, key-scope detection, project
create/delete, the orphan sweep, and the `e2eTest` fixture. It has no build step —
consumers import its TypeScript source.

It lives in a top-level `tests/` folder rather than under `packages/` so that
`packages/` keeps meaning exactly one thing: packages we publish. It's still a
workspace package — listed explicitly in `pnpm-workspace.yaml` and depended on with
`workspace:*` — because the alternative is every suite reaching across package roots
with `../../../tests/e2e-harness` paths, which fights both `tsc -p` and the CLI's
`moduleResolution: node` mappings for no benefit.

It exists because cleanup is the dangerous part, and three copies of it meant fixing
every bug three times. Three invariants live there and nowhere else:

1. **Prefix guard** — never delete a project not named `neon-ts-e2e-*`.
2. **Age guard** — never sweep a project created in the last hour; it probably belongs
   to a concurrent run.
3. **Unprotect before delete** — Neon rejects a delete with 422 while a branch is
   protected, and an un-cleared flag makes the project unreachable by *any* later
   cleanup.

A fourth rule governs setup rather than teardown: `createProject` waits until the
project is actually usable. "Created" and "usable" are different states — Neon rejects
the next mutation with `project already has running conflicting operations` while
provisioning is in flight — so returning early would just move that race into every
caller.

**It deliberately does not use `@neon/sdk`.** The SDK is one of the packages under
test, so plumbing built on it would break teardown at exactly the moment a test
catches an SDK bug. The harness uses plain `fetch` and has zero runtime dependencies,
which also keeps the workspace graph acyclic.

Suites keep a thin local `e2e/helpers.ts` for whatever *is* their subject under test —
`@neon/config` and friends bootstrap projects through their own `NeonApi` adapter
rather than the harness's `createProject`, because that adapter is what they're
testing.

##### What the `@neon/sdk` suite covers

The SDK's unit tests answer every request with a canned `fetch` response, which proves
the mapping logic but cannot prove the API still returns the shape that logic was
written against. `packages/sdk/e2e/` targets exactly that gap across three files:

- **`workflows`** — `createAndConnect` with readiness polling, the client's `orgId`
  default, cursor pagination against cursors the API actually issues (`branches.list`
  reads `pagination.next` while `projects.list` reads `pagination.cursor`, so a stub
  can only confirm whichever the author picked), and `postgres.connectionString`
  auto-resolving branch, role, and database.
- **`resources`** — the CRUD spine on one shared project: branch create/get/update/
  delete, `createAndConnect`, roles (including that `password` returns a bare string
  while `resetPassword` returns a `Role`), databases, endpoints, and
  `operations.waitFor` recognising terminal states.
- **`errors`** — `toNeonError` against real 404 and 401 envelopes, `throwOnError`
  narrowing, the raw layer's `Response`, and the org-key scope boundary.

Note what an **org-scoped** key cannot reach: `user.me()`, `apiKeys.list()`, and
`regions.list()` all answer `404 "not allowed for organization API keys"`. That's why
those namespaces aren't covered — not because they don't matter.

##### What the CLI (`neon`) suite covers

`packages/cli/e2e/` spawns the built binary (`dist/cli.js`, the real `bin` entry) and
parses `--output json`. The CLI's unit tests answer every request from a local
`emocks` fixture server, so they verify argument plumbing and output formatting but
never that a command still works against Neon.

Each invocation is hermetic: `--api-key` from the environment, plus `--config-dir` and
`--context-file` pointed at temp directories so a developer's real credentials or a
stray `.neon` in the checkout can't leak into a run. `--no-analytics` keeps Segment
out of it.

`test:e2e` builds first, because unlike the other packages the CLI has no `prepare`
script and `pnpm install` therefore leaves `dist/` stale.

One thing to know: **the CLI does not read `NEON_ORG_ID`.** It takes the org from
`--org-id` or a `.neon` context file, so the suite's `orgArgs()` helper translates the
harness's env var into the flag.

### Linting & Formatting

```bash
# Format code (uses Biome)
pnpm format

# Run lint checks for CI
pnpm lint:ci
```

### Package Testing

```bash
# Test CLI with prompts
pnpm --filter neon-new dry:run:prompt

# Test CLI with defaults
pnpm --filter neon-new dry:run
```

## Architecture

### Monorepo Structure

-   Uses pnpm workspaces (`packages/*`); shared dependency versions are pinned via the pnpm catalog (`pnpm-workspace.yaml`)
-   Uses Biome for linting/formatting instead of ESLint/Prettier
-   Builds with `tsdown` for bundling and `tsc --noEmit` for type-checking (see each package's `build` script)
-   Package manager: pnpm@10.30.3. **Node.js requirements are split** (see `CONTRIBUTING.md`): contributors need **Node >=22** (pnpm needs 22.13+; regenerating `@neon/sdk` via `@hey-api/openapi-ts` needs 22.18+), while every **published package** targets **Node >=20.19** at runtime (`engines.node: ">=20.19.0"` — the real floor of the dependency trees, driven by `chokidar@5`/`yargs@18`). The repo-root `package.json` keeps `engines.node: ">=22"` on purpose: it describes the contributor environment, not the shipped packages.
-   **Dependency Installation**: Prefer `pnpm dedupe` over `pnpm install` - it deduplicates dependencies in node_modules, minimizing conflict issues and reducing filesystem space
-   **Exception — `packages/cli`** (the Neon CLI): emits JavaScript with tsdown like the other packages, then keeps its own upstream `@yao-pkg/pkg` step for standalone binaries. It is linted and formatted by **Biome** like every other package (via a `packages/cli/**` override in `biome.json` that relaxes some rules and enforces `noConsole`), not ESLint/Prettier. See "The CLI package" below.

### Per-package architecture

Each package documents its own purpose, entry points, and API in its `README.md` — read the
relevant package's README rather than maintaining a duplicate (and drift-prone) inventory here.
At a high level: `neon-new` is the CLI + SDK, and `vite-plugin-neon-new` builds on it; the Config-as-Code
toolchain centers on `@neon/config` (pure, side-effect-free policy types + diff engine),
with `@neon/config-runtime` (imperative `inspect`/`plan`/`apply` + function deploy; pulls in
`esbuild`, so import it from CLIs/CI, never from a `neon.ts` policy) and `@neon/env` (resolve
+ inject a branch's env) both building on `config`; plus `@neon/ai-sdk-provider` and
`@neon/functions`.

**Pure and imperative halves are kept apart, and the boundary is load-bearing.** The
`@neon/config` / `@neon/config-runtime` pair is the package-level version of it:

| Entry point | For | Side effects |
| --- | --- | --- |
| `@neon/config` / `@neon/config/v1` | `neon.ts` policies, apps, anything embedding the toolchain | None. Never reads `process.env` or a file |

`@neon/env` draws the same line, but **not** with a second entry point. Everything it publishes
is pure. The stateful half — `fetchEnvReusingSecrets`, which reads an env source and mints and
revokes branch credentials — lives in the private `@neon-internals/env-core`, bundled into
`@neon/env` and the `neon` CLI. It was published at `@neon/env/runtime` until 0.16.0; its only consumers
were our own two CLIs, and a library that revokes credentials because you imported it is one you
cannot safely embed. See `packages/env/CONTRIBUTING.md`.

`paths` exists because three readers each grew their own answer to "where is the config
directory" and all three disagreed: the CLI honoured `XDG_CONFIG_HOME` but not
`NEONCTL_CONFIG_DIR`, `@neon/env` honoured the env var but not XDG, and the init flow
hardcoded `~/.config/neonctl`. With `XDG_CONFIG_HOME` set, the CLI wrote credentials
somewhere the other two never looked. **That implementation now lives in `@neon-internals/cli-core`**, and
the `@neon/config/paths` subpath is gone — it was a workaround for having nowhere else to put
implementor-only code, was never documented in the package's README, and nothing outside this
repo imported it. See below.

### `internals/` — private packages bundled into their consumers

Credential reading, profile resolution and config paths are shared by `neon` and `@neon/env`
from `@neon-internals/cli-core` — the two that read a credential off disk; `@neon/config` takes
an explicit key and reads nothing. `@neon-internals/env-core` is the second one, holding
`fetchEnv` and `fetchEnvReusingSecrets`.

Both are `"private": true`, listed in each consumer's **`devDependencies`**, and inlined at
build time because `packages/cli` and `packages/env` build with tsdown bundling on. So the code
is compiled into every `dist` and nothing resolves at runtime. That is the whole reason the
consumers bundle: a bare `@neon-internals/*` specifier surviving into `dist` would fail to
resolve for anyone who installed from npm, and `tsc` cannot inline anything —
[`paths` does not change emitted import paths](https://www.typescriptlang.org/tsconfig/paths.html).

Two separate things have to be right, and it is worth not conflating them. **`external` in each
consumer's `tsdown.config.ts` is what inlines them** — it keeps every package import a runtime
import except `@neon-internals/*`. **`devDependencies` is what keeps them out of the published
manifest**, and that is the half npm enforces: a `dependencies` entry naming an unpublished
package makes `npm install neon` fail, while the code would still be bundled and the build would
still look fine. `packages/cli/src/package_exports.test.ts` pins both.

They emit declarations even though nothing publishes them: `@neon/env` re-exports types that
originate in `env-core`, and a declaration bundler can only inline declarations that exist.
That is what `dts: { resolve: [/^@neon-internals\//] }` in `packages/env/tsdown.config.ts` is for.

**They are ordinary workspace dependencies, so build from the root.** `pnpm build` and
`pnpm install` order them topologically; `pnpm --filter neon build` on its own compiles against
whatever `internals/*/dist` is already there, exactly as it does for `@neon/config` and every
other workspace dependency. Use `pnpm --filter neon... build` after editing one. Consumers must
**not** build the internals themselves: two of them doing that under a recursive `pnpm build`
race on the same `dist`, and `clean: true` means one can delete it while the other is reading.

Bundled code lands in `dist/_chunks/`, kept off the `neon` tarball's public surface by
`"./dist/_chunks/*": null` in its `exports` — without that, the `./dist/*` wildcard makes
`neon/dist/_chunks/credentials-<hash>.js` a public credential reader.
`packages/cli/src/package_exports.test.ts` pins it.

**Keep them dependency-free** (`cli-core`: Node builtins only; `env-core`: `@neon/config` and
nothing else) — they are bundled into each consumer, so anything they import becomes a runtime
dependency of every consumer. Keep loggers, yargs and API clients out; take a callback or a
value instead. `cli-core`'s unit tests live in `packages/cli` and `env-core`'s in
`packages/env`, so each is covered once; `@neon/env`'s `resolve-api-key.test.ts` additionally
checks that the two CLIs agree on credential precedence. Nothing re-exports them from a
published package, so credential paths and ownership checks cannot become someone else's public
API by accident.

The directory is `neon`; `neonctl` is the pre-rename name and is **read forever, in place**.
Nothing is moved, copied, or deleted, so a second copy of a credential can never go stale
behind the first. An explicitly chosen directory is exact and never falls back — a CI run
pointed at a scratch directory must not pick up a developer's credentials.

**Credentials are always passed in, never discovered.** `@neon/config`, `@neon/config-runtime`
and the `@neon/env` root export read **no environment variables and no files** to find a Neon
API key. `createNeonApiFromOptions` takes an explicit `apiKey` and raises
`PLATFORM_MISSING_API_KEY` without one; it does not consult `NEON_API_KEY` or
`~/.config/neonctl/credentials.json`. Resolving *where* a key comes from belongs to whatever
embeds these packages, because only it knows which ambient sources its users expect — and a
library that silently authenticates as whoever last ran `neon auth` is a library you cannot
safely embed. The two implementations in this repo are `packages/cli` (`ensureAuth` +
`resolveApiKeyFromEnv`) and `packages/env`'s CLI (`src/lib/cli/resolve-api-key.ts`). Copy one
rather than pushing the lookup back down.

Before adding an export to `@neon/env`, read
**[`packages/env/CONTRIBUTING.md`](packages/env/CONTRIBUTING.md)**. It has the test for whether
a change belongs on the published surface or in `@neon-internals/env-core`, why the
credential-reuse logic cannot live on the root export, and what each of the three homes holds.
`packages/cli` does not depend on `@neon/env` at all — it bundles the same internals package —
so "reach into an internal" is not a thing it can do.

### The CLI package (`packages/cli`)

`packages/cli` is the **Neon CLI**, migrated from [`neondatabase/neonctl`](https://github.com/neondatabase/neonctl), and is published as **`neon`**. `packages/neonctl` is a lightweight compatibility package whose executable imports `neon/cli`; it contains no CLI implementation or build output. The two packages are a Changesets fixed group and release at the same version. Human `-o table` output is specified in [`packages/cli/AGENTS.md`](packages/cli/AGENTS.md). The primary package is linted/formatted with Biome like the rest of the repo, but its **build** toolchain differs:

-   **Build**: `pnpm --filter <name> build` runs swagger param generation (`generateOptionsFromSpec.ts` → `src/parameters.gen.ts`, a committed generated file), then `tsc --noEmit` and `tsdown` to `dist/`, then copies `callback.html` into `dist/`. Every non-test source file is an entry, so each keeps its own path under `dist/` and the `./dist/*` wildcard export still resolves; only the private `@neon-internals/*` packages are inlined, into `dist/_chunks/`. It **publishes from the package root** (`bin: dist/cli.js`, `files: ["dist", …]`). The param generator reads the OpenAPI spec from the `@neon/sdk` workspace package's vendored copy (`../sdk/spec/neon-openapi.json`, kept in sync via its `spec:pull` script), so it works offline within the monorepo.
-   **Lint**: Biome, via a `packages/cli/**` override in the root `biome.json` (relaxes some rules for the migrated upstream code, and enforces `noConsole` since the CLI routes all output through its writer/logger). Root `pnpm lint:ci` (`biome ci`) covers it. `pnpm --filter <name> lint` additionally runs `tsc --noEmit` then `biome check src`.
-   **Coverage**: needs `@vitest/coverage-v8` because the root CI runs `pnpm test:ci --coverage` (the flag is appended to every package's `test:ci`). Pin it to the package's `vitest` major.
-   **Standalone binaries**: `pnpm --filter neon bundle` (`node pkg.js`) Rollup-bundles `dist/cli.js` and cross-compiles `linux-x64`, `linux-arm64`, `macos-x64`, and `win-x64` via `@yao-pkg/pkg`; targets/assets are declared in the package's `pkg` block. The binaries are named after the package, so they ship as `neon-<target>`.
-   **Conformance tests** (`tests/psql-conformance`) need Docker/testcontainers and are excluded from the default Vitest run; run them explicitly with `pnpm --filter <name> test:conformance`.
-   **Sibling deps**: every internal dependency — the `@neon/*` packages — is `workspace:*`. Never pin one to a published version; see "Publish order" below for the lockfile deadlock that caused.
-   **`neon init` is a thin orchestrator** in `src/commands/init.ts`. Empty directory (only `.git`) → `bootstrap .` (or `--default` with `-y`) and stop; bootstrap owns install, agent tooling, and link. Existing app → plugin or skills+MCP (never both), then `link` if `.neon` has no projectId, then `config init` (`--services none` on `-y`). `src/init/plan.ts` is the planner; `src/init/tooling.ts` runs the children; `src/init/bootstrap.ts` is the template scaffolding core that `commands/bootstrap.ts` uses. Init itself skips `ensureAuth`; the child commands authenticate.
-   **Package manager detection** lives in `src/utils/package_manager.ts`, and it is the only module allowed to read a lockfile or `npm_config_user_agent`. Installing into a project directory uses `resolvePackageManager(cwd)` (lockfile walk, then invocation, then PATH, then npm); global installs and fresh scaffolds with no lockfile yet use `resolveInvokingPackageManager()`; an interactive flow that can prompt uses `inferPackageManager(cwd)`, which returns undefined rather than guessing. Never spell an install command by hand — `formatInstallCommand()` builds the string for agent JSON and printed hints, `installArgs()` and `globalInstallArgs()` build argv for `runCommand`, and `execCommand()` builds the line that runs a binary the project depends on (`pnpm exec drizzle-kit`, `npx --no prisma`). A hardcoded `npm install` in an agent instruction is a bug: it tells the agent to run npm against a pnpm project. A bare `npx`/`bunx` is a bug too — both download a missing package instead of failing, so use `execCommand()` for anything the project already depends on.

### The SDK package (`packages/sdk`)

`@neon/sdk` is the official TypeScript SDK for the Neon API — a Fetch-based client
generated from Neon's OpenAPI spec, with a hand-authored ergonomic layer on top. See
`packages/sdk/README.md` for the public API.

**Regenerating the client (local):**

```bash
pnpm --filter @neon/sdk spec:pull   # refresh vendored spec from neon.com
pnpm --filter @neon/sdk generate    # regenerate packages/sdk/src/client
pnpm --filter @neon/sdk build       # typecheck + bundle
pnpm --filter @neon/sdk test:ci     # coverage guard — see below
```

The vendored spec lives at `packages/sdk/spec/neon-openapi.json`. Codegen is
`@hey-api/openapi-ts` (`packages/sdk/openapi-ts.config.ts`).

**`@neon/sdk` is published zero-dependency, and `build` enforces it.**

tsdown externalizes whatever `dependencies` lists and **inlines everything else**, so an
import of a devDependency from any file matched by the `entry` globs is copied into
`dist/node_modules/` and published. That shipped 743KB of `vitest`, `chai`,
`expect-type`, `loupe` and `tinyrainbow` in 1.4.0: `src/neon/client.test-d.ts` imports
`expectTypeOf`, and the globs excluded only `*.test.ts`. Note that `!src/**/*.test.*`
does **not** match `client.test-d.ts` — the `test-d` exclusion is separate, which is why
`@neon/config` and `@neon/env` list both.

`pnpm --filter @neon/sdk build` ends in `node scripts/check-dist.mjs`, which fails when
`dist/` carries bundled dependencies, emitted test files, a runtime dependency in any of
`dependencies` / `peerDependencies` / `optionalDependencies`, or a bare import a consumer
would have to install. The checks live in `scripts/dist-guard.mjs` and are covered by
`scripts/dist-guard.test.mjs` against real temporary package trees.

**Manifest checks alone are not enough**, which is worth knowing before simplifying this.
tsdown externalizes `dependencies` **∪ `peerDependencies`** (`getPackageDeps` in
`tsdown/dist/src-XtWW9dvn.mjs`) and honours an explicit `external` option that no manifest
field records, so a dependency can leave the build as a bare import with nothing in
`package.json` to reveal it. The emitted code is therefore parsed too — with
`es-module-lexer`, not a regex: a regex flags imports inside strings and comments, which
misfired on this package's own `@example` JSDoc, and misses imports spanning lines.

CI's Build job runs `pnpm build`, so a regression fails the PR rather than reaching npm.
Don't route around it by relaxing the check — fix the entry globs or move the offending
file out of them.

**Automated spec refresh (`.github/workflows/sdk-spec-refresh.yml`):**

The live spec at https://neon.com/api_spec/release/v2.json can drift ahead of the
vendored copy on `main`. A scheduled workflow keeps maintainers aware:

| | |
| --- | --- |
| **When** | Daily at 09:00 UTC; also `workflow_dispatch` |
| **What** | `spec:pull` → `generate` → `build` on `@neon/sdk` |
| **Output** | Opens or updates a PR on branch `bot/sdk-spec-refresh` titled `chore(@neon/sdk): refresh OpenAPI spec` — **only when something changed** |
| **Runner** | Protected runner group + JFrog. The spec is pulled from neon.com. |

**The bot PR is a starting point, not merge-ready.** The workflow deliberately does
not run `test:ci`. CI will fail on `packages/sdk/src/neon/coverage.test.ts` until
someone updates `packages/sdk/src/neon/coverage.ts`:

1. Review added/removed operations in `sdk.gen.ts`.
2. Wrap new ops in the ergonomic layer where warranted (and add them to `WRAPPED`),
   or accept them as raw-only.
3. Update `EXPECTED_OPERATIONS` to match the new generated set.
4. **Update `packages/sdk/README.md`** — the API reference section must stay in sync
   with every new ergonomic namespace/method (see below).
5. Run `pnpm --filter @neon/sdk test:ci` locally.
6. Add a changeset if the refresh should ship a new `@neon/sdk` version.

**Adding or changing ergonomic APIs — always update the README:**

`packages/sdk/README.md` is the public API reference for `createNeonClient`. Whenever
you add, rename, or remove an ergonomic wrapper (not raw-only endpoints), update the
README in the **same PR**:

1. Add or edit the matching section under **API reference** (method tables + a short
   example when the call shape is non-obvious — e.g. multipart deploy, presigned upload).
2. Keep the same conventions as existing sections: **[P]** for paginated `list()`,
   **→void**, nested sub-resources (`neon.storage.buckets`, `neon.postgres.roles`, …).
3. If a namespace is new, add a `### neon.<namespace>` heading in logical order
   (branch-scoped features after `neon.branches` / `neon.postgres`).
4. Do **not** duplicate the full raw inventory — raw-only endpoints stay documented
   implicitly via the **Raw layer** section.

`hey-api` does not treat Neon's `x-stability-level` (alpha/beta) differently — beta
and private-preview endpoints are generated identically to stable ones. Access
control stays on the API side.

### Key Implementation Details

-   `neon-new` (CLI) and `vite-plugin-neon-new` (plugin) both support SQL seeding via the `--seed` flag (CLI) or `seed.path` option (plugin)
-   Databases are "claimable" with 72-hour expiration URLs
-   The plugin writes both direct and pooled connection strings
-   The SDK provides an `instantNeon()` function for programmatic usage
-   Uses TypeScript with strict configuration
-   All packages use ESM modules (`"type": "module"`)

### Development Patterns

-   Uses Changesets for version management (`pnpm changeset`)
-   Husky for git hooks with lint-staged
-   Vitest for testing with `--passWithNoTests`
-   TypeScript compilation with `tsc --noEmit` before bundling

## Release Management

This project uses [Changesets](https://github.com/changesets/changesets) for version management. (Publishing to npm happens externally — see "Cutting a Release" below.)

### Creating a Changeset

When you make changes that should be published, create a changeset:

```bash
# Generate a new changeset
pnpm changeset
```

This will:
1. Prompt you to select which packages have changed
2. Ask you to specify the bump type (major, minor, patch) for each package
3. Request a summary of the changes
4. Create a markdown file in `.changeset/` directory describing the changes

### Cutting a Release

This repo does **not** publish to npm. Publishing happens from a **private mirror**; the CI
here (`.github/workflows/ci.yml`) only builds, lints, and tests. There is no automated
"Version Packages" PR bot — those workflows were removed. A release in this repo is just a
**version-bump + `CHANGELOG.md` commit landed on `main`** via a PR; the mirror publishes it.

To cut one:

1. Make sure every changed package has a changeset under `.changeset/` (see above).
2. Run the version bump — this consumes the changeset files, rewrites `package.json`
   versions, appends to each `CHANGELOG.md`, and patch-bumps internal dependents
   (`updateInternalDependencies: "patch"`, all internal deps are `workspace:*`):

   ```bash
   pnpm changeset version
   ```

3. Verify (`git status`, `pnpm lint:ci`), commit, and open a PR.

The `release` Claude Code skill (`.claude/skills/release/`) automates this end to end,
including a git-vs-npm check that flags packages which changed but lack a changeset.

### Publish order

**Publish leaf dependencies first, the CLI last:**
`@neon/config` → `@neon/config-runtime` / `@neon/env` → `neon` → `neonctl`.
Publishing `neon` also ships the standalone binaries and the GitHub release; publish the
compatibility package only after `npm view neon version` confirms the matching primary package.
Verify each with `npm view <pkg> version`. Then `npm i -g neon@latest`.

Ordering is a courtesy to npm consumers, not a build constraint. Every internal dependency is
`workspace:*`, so a package is always built and packed against workspace source and never makes a
registry round-trip for a sibling.

**Never pin an internal package to a published version.** `packages/cli` pinned `neon-init` (a
package since folded into `packages/cli/src/init`) that way until 2.39.0, and it deadlocked every
release that bumped it: `changeset version`
rewrote the pin without touching `pnpm-lock.yaml`, so `pnpm install --frozen-lockfile` failed with
`ERR_PNPM_OUTDATED_LOCKFILE` across the whole workspace — every CI job and every publish, not just
the CLI's — and `pnpm install` could not repair it, because pnpm 10 defaults
`link-workspace-packages=false` and tried to fetch a version that was unpublished precisely because
the install was broken. Breaking that required publishing from a throwaway ref with the pin
reverted. `workspace:*` cannot reach that state: the lockfile records a `link:` and no version
appears in it at all.

### Publishing the CLI (`neon` + the `neonctl` compatibility package)

The CLI publishes from this monorepo via the same external workflow as every other package
(`databricks/secure-public-registry-releases-eng` → `neon-pkgs.yml`, dispatched per package with
`-f package=<name>`). It takes **two dispatches**, `neon` then `neonctl`, and a few things are
specific to it:

- **Standalone binaries + GitHub release**: the `neon` dispatch (and only that one — the workflow
  gates on `inputs.package == 'neon'`) cross-compiles the `@yao-pkg/pkg` binaries and attaches them
  to a **GitHub release on `neondatabase/neon-pkgs`**, tagged `neon@<version>` and titled
  `Neon CLI <version>`. The tag keeps the `<package>@<version>` shape every other package uses; the
  title is what people read. The old standalone `neonctl` repo release pipeline is retired.
- **Binaries ship under two names.** The workflow uploads each binary as both `neon-<target>` and
  the legacy `neonctl-<target>`. This is deliberate: `neon.com/docs/cli/install` documents
  `releases/latest/download/neonctl-<target>`, a rolling URL that users have copied into their own
  CI, so dropping it would break them silently. Don't remove the duplicate upload without checking
  those download counts first.
- **Compatibility command**: `neonctl` is a thin package that depends on `neon` (`workspace:*`)
  and owns only the legacy `neonctl` executable. `pnpm pack` rewrites that to an **exact** version
  pin, so `npm i neonctl` cannot resolve until the matching `neon` is on npm. Publish `neon` first,
  verify it, then dispatch `-f package=neonctl`. It has no binaries. This ordering applies to every
  CLI release, not just the one that introduced the split.
- **Homebrew**: `brew install neonctl` is a homebrew-core formula built from the npm `neonctl`
  tarball (autobumped by Homebrew's bot), not something this repo publishes. It relies on that
  package providing **both** the `neonctl` and `neon` commands — don't narrow the shim's `bin` map;
  see `docs/neonctl-compatibility-shim.md`. The formula's `test` block also asserts that
  `neonctl --api-key DOES-NOT-EXIST projects create` prints **"Authentication failed"** and exits 1,
  so that phrase is load-bearing: rewording it breaks the formula.

**Downstream of a CLI rename or retag**, two things in `neondatabase/website` are coupled to the
names and neither fails loudly: `content/docs/cli/install.md` hardcodes the binary download URLs,
and `scripts/docs-checks/neonctl/refresh.js` selects the release to regenerate the CLI reference
from by tag prefix — if that prefix stops matching, it silently freezes the docs at the last
matching release instead of erroring.

### Best Practices

- Always create a changeset for user-facing changes
- Write clear, user-focused summaries in changesets
- Commit changeset files with your feature branch
- One changeset per logical feature/fix (but can bump multiple packages)
