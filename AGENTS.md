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

### Per-package architecture

Each package documents its own purpose, entry points, and API in its `README.md` — read the
relevant package's README rather than maintaining a duplicate (and drift-prone) inventory here.
At a high level: `neon-new` is the CLI + SDK, and `vite-plugin-neon-new` builds on it; the Config-as-Code
toolchain centers on `@neondatabase/config` (pure, side-effect-free policy types + diff engine),
with `@neondatabase/config-runtime` (imperative `inspect`/`plan`/`apply` + function deploy; pulls in
`esbuild`, so import it from CLIs/CI, never from a `neon.ts` policy) and `@neondatabase/env` (resolve
+ inject a branch's env) both building on `config`; plus `neon-init`, `@neondatabase/ai-sdk-provider`,
and `@neondatabase/functions`.

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

### Best Practices

- Always create a changeset for user-facing changes
- Write clear, user-focused summaries in changesets
- Commit changeset files with your feature branch
- One changeset per logical feature/fix (but can bump multiple packages)
