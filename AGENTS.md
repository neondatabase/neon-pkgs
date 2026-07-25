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
-   **Exception — `packages/cli`** (the Neon CLI): keeps its own upstream *build* toolchain (`tsc` → `dist`, `@yao-pkg/pkg` binaries) rather than tsdown. It is linted and formatted by **Biome** like every other package (via a `packages/cli/**` override in `biome.json` that relaxes some rules and enforces `noConsole`), not ESLint/Prettier. See "The CLI package" below.

### Per-package architecture

Each package documents its own purpose, entry points, and API in its `README.md` — read the
relevant package's README rather than maintaining a duplicate (and drift-prone) inventory here.
At a high level: `neon-new` is the CLI + SDK, and `vite-plugin-neon-new` builds on it; the Config-as-Code
toolchain centers on `@neon/config` (pure, side-effect-free policy types + diff engine),
with `@neon/config-runtime` (imperative `inspect`/`plan`/`apply` + function deploy; pulls in
`esbuild`, so import it from CLIs/CI, never from a `neon.ts` policy) and `@neon/env` (resolve
+ inject a branch's env) both building on `config`; plus `neon-init`, `@neon/ai-sdk-provider`,
and `@neon/functions`.

### The CLI package (`packages/cli`)

`packages/cli` is the **Neon CLI**, migrated from [`neondatabase/neonctl`](https://github.com/neondatabase/neonctl), and is published as **`neon`**. `packages/neonctl` is a lightweight compatibility package whose executable imports `neon/cli`; it contains no CLI implementation or build output. The two packages are a Changesets fixed group and release at the same version. The primary package is linted/formatted with Biome like the rest of the repo, but its **build** toolchain differs:

-   **Build**: `pnpm --filter <name> build` runs swagger param generation (`generateOptionsFromSpec.ts` → `src/parameters.gen.ts`, a committed generated file), then `tsc -p tsconfig.build.json` to `dist/`, then copies `callback.html` into `dist/`. It compiles file-by-file with `tsc` (not bundled with tsdown) and **publishes from the package root** (`bin: dist/cli.js`, `files: ["dist", …]`). The param generator reads the OpenAPI spec from the `@neon/sdk` workspace package's vendored copy (`../sdk/spec/neon-openapi.json`, kept in sync via its `spec:pull` script), so it works offline within the monorepo.
-   **Lint**: Biome, via a `packages/cli/**` override in the root `biome.json` (relaxes some rules for the migrated upstream code, and enforces `noConsole` since the CLI routes all output through its writer/logger). Root `pnpm lint:ci` (`biome ci`) covers it. `pnpm --filter <name> lint` additionally runs `tsc --noEmit` then `biome check src`.
-   **Coverage**: needs `@vitest/coverage-v8` because the root CI runs `pnpm test:ci --coverage` (the flag is appended to every package's `test:ci`). Pin it to the package's `vitest` major.
-   **Standalone binaries**: `pnpm --filter neon bundle` (`node pkg.js`) Rollup-bundles `dist/cli.js` and cross-compiles `linux-x64`, `linux-arm64`, `macos-x64`, and `win-x64` via `@yao-pkg/pkg`; targets/assets are declared in the package's `pkg` block. The binaries are named after the package, so they ship as `neon-<target>`.
-   **Conformance tests** (`tests/psql-conformance`) need Docker/testcontainers and are excluded from the default Vitest run; run them explicitly with `pnpm --filter <name> test:conformance`.
-   **Sibling deps**: `@neondatabase/*` + `neon-init` are currently pinned to published versions (not `workspace:*`); switching to `workspace:*` is a planned follow-up.

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

**Automated spec refresh (`.github/workflows/sdk-spec-refresh.yml`):**

The live spec at https://neon.com/api_spec/release/v2.json can drift ahead of the
vendored copy on `main`. A scheduled workflow keeps maintainers aware:

| | |
| --- | --- |
| **When** | Daily at 09:00 UTC; also `workflow_dispatch` |
| **What** | `spec:pull` → `generate` → `build` on `@neon/sdk` |
| **Output** | Opens or updates a PR on branch `bot/sdk-spec-refresh` titled `chore(@neon/sdk): refresh OpenAPI spec` — **only when something changed** |
| **Runner** | `ubuntu-latest` (public egress to `neon.com`). CI uses the protected runner group + JFrog mirror and **cannot** reach the public spec URL — same constraint as `catalog-drift.yml` |

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

### Publish order — the `neon-init` lockfile trap

**Publish leaf dependencies first, the CLI last, and mind `neon-init`.** All internal
`@neon/*` deps are `workspace:*` (linked locally, never a registry round-trip), so they don't
constrain ordering for the build. **The one exception is `packages/cli`, which pins `neon-init`
to a _published_ version** (e.g. `"neon-init": "0.20.2"`), not `workspace:*`. That single
registry pin creates a chicken-and-egg whenever a release bumps `neon-init`:

- `changeset version` bumps `neon-init` **and** rewrites the CLI's pin to the new version
  (`updateInternalDependencies: "patch"`), but **does not** update `pnpm-lock.yaml`.
- So the moment the release PR merges, `main`'s lockfile still points at the **old** `neon-init`
  while `packages/cli/package.json` wants the new one. The publish workflow's
  `pnpm install --frozen-lockfile` (whole workspace) then fails with `ERR_PNPM_OUTDATED_LOCKFILE`
  — for **every** package, since it installs the whole workspace before packing any one of them.
- You can't fix the lockfile by running `pnpm install`, because the new `neon-init` isn't on npm
  yet (pnpm 10 defaults `link-workspace-packages=false`, so it tries to *fetch* it). And you
  can't publish the new `neon-init` because the frozen install is broken. Catch-22.

**Correct order when a release bumps `neon-init`:**

1. **Publish `neon-init` first, from a throwaway ref where the lockfile is consistent.** Branch
   off `main`, temporarily revert only the CLI's `neon-init` pin back to the currently-published
   version (so `package.json` matches the still-old lockfile), push, and dispatch
   `-f package=neon-init -f ref=<that-branch>`. This publishes **only** `neon-init` — the CLI is
   never published from this throwaway ref. Delete the branch afterwards; never merge it.
2. **Sync the lockfile on `main`.** Now that the new `neon-init` is on npm, `pnpm install
   --lockfile-only` resolves it. Open a tiny `chore: sync lockfile for neon-init@<version>` PR
   (this is exactly what such historical PRs are). Its CI now passes because the lockfile matches.
3. **Publish the rest from `main`**, leaf-first, CLI implementation before its compatibility package:
   `@neon/config` → `@neon/config-runtime` / `@neon/env` → `neon` → `neonctl`.
   Publishing `neon` also ships the standalone binaries and GitHub release. Verify each with
   `npm view <pkg> version`.

If a release does **not** touch `neon-init`, none of this applies — the lockfile stays consistent
(`workspace:*` deps don't change it) and you can publish leaf-first / CLI-last straight from `main`.

**The permanent fix** is to make the CLI depend on `neon-init` via `workspace:*` like every other
internal package (see the pinned-sibling note under the CLI package above); until that lands,
follow the ordering above.

### Publishing the CLI (`packages/cli` + forwarders)

The CLI publishes from this monorepo via the same external workflow as every other package
(`databricks/secure-public-registry-releases-eng` → `neon-pkgs.yml`, dispatched per package with
`-f package=<name>`). Two CLI-specific notes:

- **Standalone binaries + GitHub release**: for the CLI package (the one with a `pkg` block), the
  workflow also cross-compiles the `@yao-pkg/pkg` binaries and attaches them to a **GitHub release on
  `neondatabase/neon-pkgs`** (tag `<name>@<version>`). The old standalone `neonctl` repo release
  pipeline is retired.
- **Compatibility command**: `neonctl` is a thin package that depends on `neon` (`workspace:*`)
  and owns only the legacy `neonctl` executable. Publish `neon` first, verify it on npm, then
  publish `neonctl` with the same workflow (`-f package=neonctl`). It has no binaries.

### Best Practices

- Always create a changeset for user-facing changes
- Write clear, user-focused summaries in changesets
- Commit changeset files with your feature branch
- One changeset per logical feature/fix (but can bump multiple packages)
