# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a monorepo for Neon Launchpad packages that provide instant Postgres database provisioning without sign-ups. It contains five main packages:
- `get-db`: A CLI tool for creating claimable Neon databases (formerly `neondb`)
- `neondb`: Deprecated alias package for `get-db` (shows deprecation warning)
- `vite-plugin-db`: A Vite plugin that automatically provisions databases (formerly `@neondatabase/vite-plugin-postgres`)
- `@neondatabase/vite-plugin-postgres`: Deprecated alias package for `vite-plugin-db` (shows deprecation warning)
- `neon-init`: A setup tool for initializing your project with Neon and Neon MCP Server

## Development Commands

### Building

```bash
# Build both packages
pnpm build

# Build CLI only
pnpm build:cli

# Build Vite plugin only
pnpm build:plugin
```

### Testing

```bash
# Run all tests
pnpm test:ci

# Run tests for specific package
pnpm --filter get-db test
pnpm --filter vite-plugin-db test
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
pnpm --filter get-db dry:run:prompt

# Test CLI with defaults
pnpm --filter get-db dry:run
```

## Architecture

### Monorepo Structure

-   Uses pnpm workspaces with two main packages
-   Shared dependencies managed at root level
-   Uses Biome for linting/formatting instead of ESLint/Prettier
-   Uses `tsdown` for TypeScript compilation instead of tsc directly
-   Package manager: pnpm@10.4.0, Node.js >=18.3.0
-   **Dependency Installation**: Prefer `pnpm dedupe` over `pnpm install` - it deduplicates dependencies in node_modules, minimizing conflict issues and reducing filesystem space

### get-db Package (formerly neondb)

-   **Entry points**: CLI (`dist/cli.js`) and SDK exports (`./sdk`, `./launchpad`)
-   **Core functionality**: Creates claimable Neon databases via API calls
-   **CLI options**: `-y/--yes`, `-e/--env`, `-k/--key`, `-s/--seed`, `-h/--help`
-   **Dependencies**: Uses `@clack/prompts` for interactive CLI, `@neondatabase/serverless` for DB operations

### neondb Package (DEPRECATED)

-   **Purpose**: Deprecated alias for `get-db` - shows deprecation warning and re-exports `get-db`
-   **Status**: Maintained for backwards compatibility but users should migrate to `get-db`

### vite-plugin-db Package (formerly @neondatabase/vite-plugin-postgres)

-   **Purpose**: Automatically provisions databases during Vite development
-   **Behavior**: Checks for DATABASE_URL in .env, creates database if missing, noop in production
-   **Configuration**: Supports custom env file path, env key name, and SQL seeding
-   **Integration**: Must be placed as first plugin in Vite config
-   **Dependencies**: Uses `get-db` internally for database provisioning

### @neondatabase/vite-plugin-postgres Package (DEPRECATED)

-   **Purpose**: Deprecated alias for `vite-plugin-db` - shows deprecation warning and re-exports `vite-plugin-db`
-   **Status**: Maintained for backwards compatibility but users should migrate to `vite-plugin-db`

### neon-init Package

-   **Purpose**: Setup tool for configuring Neon with the user's project
-   **Entry points**: CLI (`dist/cli.js`) and SDK export (`init()` function)
-   **Core functionality**: Configures MCP server for VS Code and Cursor
-   **Behavior**:
    -   Detects available editors installed on the system
    -   Prompts user to select which editor(s) to configure
    -   Authenticates via OAuth using `neonctl`
    -   Creates API key automatically via Neon API
    -   Writes MCP configuration
-   **Dependencies**: Uses `@clack/prompts` for interactive CLI, `execa` for running `neonctl`

### Key Implementation Details

-   Both packages support SQL seeding via `--seed` flag (CLI) or `seed.path` option (plugin)
-   Databases are "claimable" with 72-hour expiration URLs
-   Plugin writes both direct and pooled connection strings
-   SDK provides `instantNeon()` function for programmatic usage
-   Uses TypeScript with strict configuration
-   All packages use ESM modules (`"type": "module"`)

### Development Patterns

-   Uses Changesets for version management (`pnpm changeset`)
-   Husky for git hooks with lint-staged
-   Vitest for testing with `--passWithNoTests`
-   TypeScript compilation with `tsc --noEmit` before bundling

## Release Management

This project uses [Changesets](https://github.com/changesets/changesets) for version management and publishing.

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

### Automated Release Process

The CI workflow automatically handles releases:

1. **Detection**: CI scans for changeset files in the `.changeset/` directory
2. **PR Creation**: When changesets are detected on the main branch, CI automatically creates a "Version Packages" PR
3. **Version Bump**: This PR includes:
   - Updated version numbers in `package.json` files
   - Updated `CHANGELOG.md` files with the changeset summaries
   - Removal of the processed changeset files
4. **Publishing**: When the "Version Packages" PR is merged, CI automatically publishes the new versions to npm

### Best Practices

- Always create a changeset for user-facing changes
- Write clear, user-focused summaries in changesets
- Commit changeset files with your feature branch
- One changeset per logical feature/fix (but can bump multiple packages)
