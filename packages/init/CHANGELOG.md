# neon-init

## 0.20.5

### Patch Changes

- b8217bc: Name the database Lakebase Postgres, and stop calling Neon a platform

  Copy only, no behaviour change beyond one error message string.

  - `neon`: the npm description no longer says "Neon Serverless Postgres"; the README names the primitives the CLI manages.
  - `@neon/config` and `@neon/config-runtime`: "Config-as-Code for the Neon Platform" is now "Config-as-Code for Neon", in the npm descriptions, the README, and the `v1` doc comments.
  - `@neon/config`: the validation error `Invalid Neon platform config:` is now `Invalid Neon config:`. Anything matching on that string needs updating.
  - `neon-init`: `neon-init auth` is described as "Manage Neon authentication"; the signup prompt no longer calls Neon "a serverless Postgres provider"; two bootstrap template blurbs say Lakebase Postgres.
  - `neon-new`: README says "a claimable Lakebase Postgres database on Neon" — claimable databases are Neon-only, so the access path is named.

## 0.20.4

### Patch Changes

- fac9ab2: `neon-init --version` now prints the installed version instead of `unknown`.

## 0.20.3

### Patch Changes

- 54ab231: Stop installing the Neon editor extension during default setup while keeping it available as an option during customized setup.

## 0.20.2

### Patch Changes

- 3abe4f7: Update platform-feature-unavailable errors for the beta rollout: drop outdated
  "private preview" / "Preview feature" wording, say features are currently in
  beta and only in `aws-us-east-2` (more regions coming shortly), and treat API
  bodies that say a feature is unavailable for the project/region as a region gate
  (not a transient incident) even when the status is 503. `neon-init`
  getting-started prompts use the same wording.

## 0.20.1

### Patch Changes

- 22d5cdd: Reference the `neon` CLI over `neonctl` in user-facing output and docs. The CLI
  ships both the `neon` and `neonctl` binaries; `neonctl` keeps working as an
  alias, but `neon init` now emits `neon …` commands, status messages, and
  agent-facing prompts using the cleaner `neon` name, and the package READMEs
  document `neon`. Internal package install/version checks and the
  `~/.config/neonctl/` config path are unchanged.

## 0.20.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

## 0.19.0

### Minor Changes

- 498daf7: Redesign the interactive template picker. Rows now show the template title only, and the focused row expands to `Title (tools)` with the description on its own dimmed, italic line beneath — driven by a custom `@clack/core` select so the focused option can span multiple lines. Bootstrap templates gain an optional `tools` list (the libraries/frameworks that shape the project), parsed from the manifest and surfaced in both the interactive and agent-guided flows.

## 0.18.0

### Minor Changes

- 700ec26: Bring the full template bootstrap implementation into `neon-init` and expose it via a new `neon-init/bootstrap` entry point.

  Previously `neon-init` only knew how to read the template manifest and shelled out to `npx -y neonctl@latest bootstrap` to actually scaffold a project. The manifest layer has been replaced with the complete, in-house implementation (manifest fetch/parse, single-request `codeload.github.com` tarball download, in-house gunzip + tar parsing, and on-disk scaffolding with exec-bit and symlink fidelity), so the interactive and agent setup flows now scaffold in-process — no global `neonctl` and no `npx` round-trip required.

  The new `neon-init/bootstrap` export ships `fetchTemplates`, `parseManifest`, `downloadTemplate`, `scaffoldTemplate`, `ensureTargetUsable`, `BootstrapInputError`, `FALLBACK_TEMPLATES`, and the `BootstrapTemplate` / `TemplateFile` / `NeonFeature` types. `BootstrapTemplate` now carries both `services` (display badge) and `requires` (Neon features) so it is a superset of the previous shape.

## 0.17.0

### Minor Changes

- d740d86: Add agent-driven v2 orchestrator, interactive init mode, bootstrap templates, feature-driven setup, and preview mode

### Patch Changes

- 31a6fef: Make project bootstrapping resilient to GitHub rate limits.

  - `neon init` now delegates scaffolding to `npx -y neonctl@latest bootstrap`, so a stale globally-installed `neonctl` can't be picked up — users always get the version of the CLI that downloads templates via the codeload tarball (no `api.github.com` rate limit) rather than the old REST tree-walk that failed with "GitHub API rate limit exceeded".
  - The template manifest is now fetched from neon.com first (CDN-backed, no GitHub rate limiting), falling back to the raw GitHub copy and then a built-in list.
  - The built-in fallback list now includes all starters (hono, ai-sdk, mastra), so the picker stays complete even when every manifest source is unreachable.

- 6e0acd9: Support NEON_API_HOST env var for targeting staging environments. When set, all neonctl commands (including agent-issued ones) include --api-host and --oauth-host flags.

## 0.14.0

### Minor Changes

- 83b5686: - Add support for a whole new set of IDEs via add-mcp (Claude Desktop, Codex, OpenCode, Antigravity, Cline, Cline CLI, Gemini CLI, GitHub Copilot CLI, Goose, MCPorter, Zed), with agent skills installed for supported agents.
  - Continue to editor selection when no supported editors are detected (no confirmation prompt).

## 0.13.1

### Patch Changes

- d839446: Allow skill installs from neon init to be reported to skills.sh , so installations count as executions on the skills ecosystem. User's own DISABLE_TELEMETRY env is still respected.

## 0.13.0

### Minor Changes

- a57e18a: Add `--agent` / `-a` flag to configure a single agent without the editor selection prompt. Accepts `cursor`, `copilot`, or `claude` (and common aliases like `Cursor`, `VS Code`, `Claude CLI`).

## 0.12.1

### Patch Changes

- 9c45079: Install only the neon-postgres skill specifically using the --skill flag instead of installing all skills from neondatabase/agent-skills

## 0.12.0

### Minor Changes

- 561e679: Add automatic installation of Neon agent skills via Vercel's skills CLI. The init command now runs `npx skills add neondatabase/agent-skills` for each configured editor.

## 0.11.1

### Patch Changes

- 52537ed: Fix Node.js v24 compatibility by updating engine requirement from `"22"` to `">=22"`

## 0.11.0

### Minor Changes

- 0f641cf: Install Neon Local Connect extension for VS Code and Cursor instead of MCP Server.

  - VS Code and Cursor now use the Neon Local Connect extension for local database development
  - Claude CLI continues to use the MCP Server
  - Extension is automatically installed via CLI with robust path detection (checks known installation paths, uses mdfind on macOS)
  - API key is automatically configured via extension URI handler
  - Falls back to showing marketplace links if CLI installation fails

## 0.10.1

### Patch Changes

- 0f3cc14: Update init output message to "Get started with Neon" instead of "Get started with Neon using MCP resource"

## 0.10.0

### Minor Changes

- cc3eff2: Add support for VS Code and Claude CLI in addition to Cursor. The CLI now:

  - Automatically detects which editors are installed on your system
  - Allows you to select and configure multiple editors at once
  - Supports VS Code with global (or workspace-level as a fallback) MCP configuration
  - Supports Claude CLI with global MCP configuration

## 0.9.1

### Patch Changes

- 5430282: Fix instructions to ensure MCP resources are detected by prompting users to restart Cursor after MCP server installation. The newly installed MCP server occasionally didn't detect the MCP resources without a restart.

## 0.9.0

### Minor Changes

- 0174963: **Agent guidelines now served via MCP resource**

  Removed AGENTS.md and .neon/AGENTS.md file creation logic. Agent guidelines are now provided directly by the Neon MCP Server as an MCP resource, eliminating the need to create local files in user projects.

  Changes:

  - Removed functions for creating AGENTS.md and .neon/AGENTS.md files
  - Removed organization fetching and selection (no longer needed for local files)
  - Simplified the CLI flow to only configure the MCP server
  - Updated README to reflect that guidelines are built into the MCP server
  - Reduced bundle size by ~19%

  Users should now use "Get started with Neon using MCP Resource" to access the interactive onboarding flow.

## 0.8.1

### Patch Changes

- c745c8e: Improve agents template with better guidance for .env handling and database driver setup:

  - Add explicit safeguards to prevent accidental .env file overwrites when files are in ignore lists
  - Require LLMs to read .env before modifying it and use append commands when files are unreadable
  - Update established project guidance to automatically integrate installed drivers with existing code
  - Clean up output during authentication flow based on user feedback

## 0.8.0

### Minor Changes

- aeefc80: Consolidate CLI output and other minor edits to CLI flow

## 0.7.0

### Minor Changes

- 40cd439: - Use execa instead of spawn for Windows support
  - Update copy for CLI output
  - Install the remote MCP server for users

## 0.6.0

### Minor Changes

- fb4fdf1: - Refactored Neon guidelines to use a separate `neon.md` file instead of adding bulk content to `AGENTS.md`
  - `AGENTS.md` now contains only a minimal reference that triggers when users say "Get started with Neon"
  - Added confirmation prompt when replacing existing `neon.md` files
  - Check for Cursor installation and provide helpful feedback when Cursor isn't installed

## 0.4.1

### Patch Changes

- ff02c00: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts

## 0.4.0

### Minor Changes

- e6d3d49: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts

## 0.3.0

### Minor Changes

- 20c0975: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts

## 0.2.1

### Patch Changes

- 218de01: Fix release flow

## 0.2.0

### Minor Changes

- dace8ad: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts
