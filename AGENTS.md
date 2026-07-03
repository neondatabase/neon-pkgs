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
-   Package manager: pnpm@10.30.3, Node.js >=22
-   **Dependency Installation**: Prefer `pnpm dedupe` over `pnpm install` - it deduplicates dependencies in node_modules, minimizing conflict issues and reducing filesystem space
-   **Exception — `packages/cli`** (the Neon CLI): keeps its own upstream *build* toolchain (`tsc` → `dist`, `@yao-pkg/pkg` binaries) rather than tsdown. It is **still formatted and linted by root Biome** — `biome.json` includes `packages/cli/**` and only relaxes some lint rules for it via an `overrides` block (it is not excluded). See "The CLI package" below.

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

`packages/cli` is the **Neon CLI**, migrated from [`neondatabase/neonctl`](https://github.com/neondatabase/neonctl). It is published as **`neonctl`** today and is being rebranded to **`neon`** (with thin `neonctl`/`neoncli` packages that depend on it and forward to it). It is the one package that does **not** follow the repo's standard toolchain:

-   **Build**: `pnpm --filter <name> build` runs swagger param generation (`generateOptionsFromSpec.ts` → `src/parameters.gen.ts`, a committed generated file), then `tsc -p tsconfig.build.json` to `dist/`, then copies `callback.html` into `dist/`. It compiles file-by-file with `tsc` (not bundled with tsdown) and **publishes from the package root** (`bin: dist/cli.js`, `files: ["dist", …]`). The param generator reads the OpenAPI spec from `node_modules/@neondatabase/api-client`, so it works offline after install.
-   **Formatting & lint**: root **Biome** governs this package (formatting + linting) and is the gate in CI (`pnpm lint:ci` → `biome ci`); the `overrides` block in `biome.json` relaxes a handful of lint rules for `packages/cli/**` + `examples/**` but the formatter still applies, so match the surrounding Biome style (tabs, double quotes, sorted imports). The package additionally ships its own `eslint.config.js` (run via `pnpm --filter <name> lint`), but that is a supplementary local check — it is **not** wired into CI. There is no Prettier here.
-   **Coverage**: needs `@vitest/coverage-v8` because the root CI runs `pnpm test:ci --coverage` (the flag is appended to every package's `test:ci`). Pin it to the package's `vitest` major.
-   **Standalone binaries**: `pnpm --filter <name> bundle` (`node pkg.js`) Rollup-bundles `dist/cli.js` and cross-compiles `linux-x64`, `linux-arm64`, `macos-x64`, and `win-x64` via `@yao-pkg/pkg`; targets/assets are declared in the package's `pkg` block. `pkg.js` rewrites `bin` to the bundled entry, so it is name-agnostic (works as `neon` or `neonctl`).
-   **Conformance tests** (`tests/psql-conformance`) need Docker/testcontainers and are excluded from the default Vitest run; run them explicitly with `pnpm --filter <name> test:conformance`.
-   **Sibling deps**: `@neondatabase/*` + `neon-init` are currently pinned to published versions (not `workspace:*`); switching to `workspace:*` is a planned follow-up.

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

### Publishing the CLI (`packages/cli` + forwarders)

The CLI publishes from this monorepo via the same external workflow as every other package
(`databricks/secure-public-registry-releases-eng` → `neon-pkgs.yml`, dispatched per package with
`-f package=<name>`). Two CLI-specific notes:

- **Standalone binaries + GitHub release**: for the CLI package (the one with a `pkg` block), the
  workflow also cross-compiles the `@yao-pkg/pkg` binaries and attaches them to a **GitHub release on
  `neondatabase/neon-pkgs`** (tag `<name>@<version>`). The old standalone `neonctl` repo release
  pipeline is retired.
- **Forwarders**: `neonctl` and `neoncli` are thin packages that depend on `neon` (`workspace:*`);
  publish them with the same workflow (`-f package=neonctl`, `-f package=neoncli`). They have no
  binaries.

### Best Practices

- Always create a changeset for user-facing changes
- Write clear, user-focused summaries in changesets
- Commit changeset files with your feature branch
- One changeset per logical feature/fix (but can bump multiple packages)
